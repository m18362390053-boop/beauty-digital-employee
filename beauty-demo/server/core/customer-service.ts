import { Store } from '../storage/store.js';
import { Workflows } from '../storage/workflows.js';
import { userMessageSchema } from '../contracts/index.js';
import { AppError } from './errors.js';
import { baseRoute, loadBusinessConfig, ruleRoute } from './registry.js';
import { ChatProvider, JevProvider, ProviderError } from './providers.js';
import type { BusinessConfig, ConsultResult, DecisionProvider, GenerationProvider, RouteRecord } from './workflow-types.js';
import { SkillPackages } from './skill-packages.js';
import { ModelSettings } from './model-settings.js';
import { createHash } from 'node:crypto';

export class CustomerService {
  readonly workflows: Workflows;
  readonly skills: SkillPackages;
  readonly modelSettings: ModelSettings;
  private baseline: BusinessConfig;
  get config(): BusinessConfig { return this.skills.config(); }
  private router: DecisionProvider;
  private generator: GenerationProvider;
  private active = new Map<string, AbortController>();
  constructor(readonly store: Store, options: { config?: BusinessConfig; router?: DecisionProvider; generator?: GenerationProvider; modelSettings?: ModelSettings } = {}) {
    this.workflows = new Workflows(store);
    this.baseline = options.config ?? loadBusinessConfig();
    this.skills = new SkillPackages(store, this.baseline);
    this.modelSettings = options.modelSettings ?? new ModelSettings();
    const values = this.modelSettings.current();
    this.router = options.router ?? new JevProvider(values.typesafeApiKey);
    this.generator = options.generator ?? new ChatProvider({ apiKey: values.chatApiKey, baseUrl: values.chatBaseUrl, model: values.chatModel });
  }
  status() {
    return { phase: 'workflow_demo', policyVersion: this.config.version, policyStatus: this.config.reviewStatus,
      notice: this.config.notice, providers: { jevConfigured: this.router.configured, chatConfigured: this.generator.configured },
      skills: this.config.skills.map(({ instructions: _instructions, knowledge, ...definition }) => ({ ...definition, knowledgeDocuments: knowledge.length })),
      intents: this.config.intents, riskLevels: this.config.riskLevels, maxConsultationMs: 45_000 };
  }
  configureModels(input: unknown) {
    const publicView = this.modelSettings.update(input);
    const values = this.modelSettings.current();
    this.router = new JevProvider(values.typesafeApiKey);
    this.generator = new ChatProvider({ apiKey: values.chatApiKey, baseUrl: values.chatBaseUrl, model: values.chatModel });
    return publicView;
  }
  async checkModels() {
    const input = { userText: '请介绍产品说明', card: { userId: 'connection-check', confirmedFacts: {}, preferences: [], concerns: [], version: 0, updatedAt: '' }, recentMessages: [] };
    const signal = AbortSignal.timeout(45_000);
    const outcome = { jev: { ok: false, message: '' }, chat: { ok: false, message: '' } };
    try { const route = await this.router.decide(input, this.config, signal); outcome.jev = { ok: true, message: route.model ?? 'Jev连接成功' }; }
    catch (error) { outcome.jev.message = error instanceof ProviderError ? `${error.code}${error.details?.networkCode ? ` (${error.details.networkCode})` : ''}` : 'JEV_CONNECTION_FAILED'; }
    try {
      const response = await this.generator.generate({ ...input,
        skill: { id: 'connection-check', version: 'v1', description: '连接测试', knowledgeScopes: ['product'], requiredFields: [], intents: ['product_advice'], instructions: '只回答连接成功。', requiresKnowledge: false, knowledge: [] },
        knowledge: { productId: 'connection-check', name: '连接检查', version: 'v1', dataKind: 'demo', sources: [], facts: [] }, comments: [], responseMode: 'conversation',
      }, signal);
      outcome.chat = { ok: true, message: response.model };
    } catch (error) { outcome.chat.message = error instanceof ProviderError ? `${error.code}${error.details?.networkCode ? ` (${error.details.networkCode})` : ''}` : 'CHAT_CONNECTION_FAILED'; }
    return outcome;
  }
  requestHandoff(userId: string, sessionId: string, reason: string) {
    const result = this.workflows.requestHandoff(userId, sessionId, reason);
    this.active.get(sessionId)?.abort(new Error('HUMAN_HANDOFF'));
    return result;
  }
  feedback(userId: string, messageId: string, input: unknown) {
    const saved = this.workflows.saveFeedback(userId, messageId, input);
    if (saved.type === 'request_human') {
      const session = this.store.getSession(userId, saved.sessionId);
      if (session.status === 'RESOLVED') return { ...saved, nextAction: 'new_session', prompt: '此会话已结束，请新建会话联系人工。' };
      return { ...saved, nextAction: 'handoff', handoff: this.requestHandoff(userId, saved.sessionId, saved.reason || 'feedback_request_human') };
    }
    return { ...saved, nextAction: saved.type === 'unresolved' ? 'clarify' : 'acknowledged',
      prompt: saved.type === 'unresolved' ? '哪部分还没解决：不够贴合、信息不清楚，还是需要人工？' : '收到，谢谢反馈 ✓' };
  }
  async consult(userId: string, sessionId: string, input: unknown, externalSignal?: AbortSignal): Promise<ConsultResult> {
    const message = userMessageSchema.parse(input);
    const config = this.config;
    const router = this.router;
    const generator = this.generator;
    const initial = this.store.getSession(userId, sessionId);
    try {
      const prior = this.workflows.result(userId, sessionId, message.requestId);
      this.store.appendUserMessage(userId, sessionId, message);
      if (prior.result) return prior.result;
      throw new AppError(409, 'CONSULTATION_IN_PROGRESS', 'Request is already running');
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'RUN_NOT_FOUND')) throw error;
    }
    const explicit = initial.status === 'RESOLVED' ? null : ruleRoute(message.content, config);
    let handoff: ReturnType<Workflows['getHandoff']> | null = null;
    if (explicit) {
      this.store.appendUserMessage(userId, sessionId, message);
      handoff = this.requestHandoff(userId, sessionId, explicit.route.ruleHits.join(','));
    }
    const begun = this.workflows.begin(userId, sessionId, message);
    if (begun.cached) return begun.cached;
    const context = this.store.getContext(userId, sessionId);
    this.workflows.captureCard(begun.runId, context.card, config.version);
    const product = this.store.getKnowledge(context.session.productId);
    const result: ConsultResult = {
      runId: begun.runId, requestId: message.requestId, sessionId, status: 'degraded', answer: null, answerKind: 'none',
      messageId: null, sourceRefs: [], route: null, warnings: [], policyStatus: config.reviewStatus, dataKind: product.dataKind,
      handoffId: handoff?.id ?? null, generation: null,
    };
    const saveRoute = (route: RouteRecord) => { result.route = { ...route }; this.workflows.saveRoute(begun.runId, route); };
    const finishTemplate = (status: ConsultResult['status'], answer: string, requireActive = true) => {
      Object.assign(result, { status, answer, answerKind: 'template' });
      return this.workflows.finish(userId, result, context.session.stateVersion, requireActive);
    };
    if (explicit) {
      saveRoute(explicit.route);
      return finishTemplate(context.session.status === 'HUMAN_ACTIVE' ? 'human_active' : 'handoff_pending', explicit.message, false);
    }
    if (context.session.status !== 'AI_ACTIVE') {
      saveRoute(baseRoute(config, 'HUMAN_OR_CLOSED_SESSION'));
      const status = context.session.status === 'RESOLVED' ? 'resolved' : context.session.status === 'HUMAN_ACTIVE' ? 'human_active' : 'handoff_pending';
      return finishTemplate(status, status === 'resolved' ? '此会话已结束，请新建会话继续咨询。' : config.templates.waiting, false);
    }
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    const deadline = AbortSignal.timeout(45_000);
    const signal = AbortSignal.any([controller.signal, deadline, ...(externalSignal ? [externalSignal] : [])]);
    let providerStage: 'jev' | 'chat' = 'jev';
    try {
      signal.throwIfAborted();
      const decisionInput = { userText: message.content, card: context.card, selectedProduct: { id: product.productId, name: product.name },
        recentMessages: context.recentMessages.map(m => ({ role: m.role, content: m.content })) };
      this.workflows.event(begun.runId, 'routing', '开始调度检查', { 模型已配置: router.configured, 可用Skill数: config.skills.length });
      const route = await router.decide(decisionInput, config, signal);
      signal.throwIfAborted();
      saveRoute(route);
      if (route.action === 'handoff' || route.riskLevel === 'high' || route.needsHumanHandoff) {
        handoff = this.workflows.requestHandoff(userId, sessionId, route.reasonCodes.join(','), begun.runId);
        result.handoffId = handoff.id;
        return finishTemplate('handoff_pending', config.templates.risk, false);
      }
      let responseMode: 'answer' | 'clarify' | 'conversation' = route.action === 'answer' ? 'answer' : route.intent ? 'clarify' : 'conversation';
      const conversationalSkill = { id: 'service-conversation', version: 'v1', description: '服务引导与针对性追问',
        knowledgeScopes: [] as ('product' | 'after_sales' | 'comment_insights')[], requiredFields: [], intents: [], requiresKnowledge: false, knowledge: [],
        instructions: `根据用户这句话自然回应。寒暄时欢迎并说明可用服务；问题不明确时只问最相关的一两个问题，不机械要求肤质和使用时间。\n可用服务：${config.skills.map(s => s.description).join('；')}。\n当前风险：${route.riskLevel ?? '未判定'}。如在澄清风险，不推荐商品。` };
      const skill = responseMode === 'answer' ? config.skills.find(s => s.id === route.primarySkill) : conversationalSkill;
      if (!skill) throw new ProviderError('UNKNOWN_SKILL');
      const facts = product.facts.filter(fact => fact.category === 'after_sales' ? skill.knowledgeScopes.includes('after_sales') : skill.knowledgeScopes.includes('product'));
      const usedSources = new Set(facts.map(fact => fact.sourceId));
      const knowledge = { ...product, facts, sources: product.sources.filter(source => usedSources.has(source.sourceId)) };
      for (const [i, document] of skill.knowledge.entries()) {
        const sourceId = `skill-${createHash('sha256').update(skill.id).digest('hex').slice(0, 12)}-${i}`;
        knowledge.sources.push({ sourceId, title: document.title, locator: `skill://${skill.id}/${skill.version}/${i}`, collectedAt: new Date().toISOString() });
        knowledge.facts.push({ factId: `${sourceId}-fact`, category: 'description', text: document.content, sourceId, reviewStatus: 'approved' });
      }
      if (!knowledge.facts.length && skill.requiresKnowledge) {
        result.warnings.push('INSUFFICIENT_EVIDENCE');
        responseMode = 'clarify';
      }
      const comments = skill.knowledgeScopes.includes('comment_insights') ? this.store.listComments(product.productId, 20, 0).items : [];
      this.workflows.captureSkill(begun.runId, skill, knowledge);
      this.workflows.event(begun.runId, 'generation', '开始组织回复', { 回复模式: responseMode, 模型已配置: generator.configured, 评论条数: comments.length });
      providerStage = 'chat';
      const generated = await generator.generate({ ...decisionInput, skill, knowledge, comments, responseMode }, signal);
      signal.throwIfAborted();
      result.answer = generated.answer;
      result.answerKind = 'generated'; result.status = responseMode === 'clarify' ? 'clarification_required' : 'answered'; result.sourceRefs = generated.sourceRefs;
      result.generation = { model: generated.model, usage: generated.usage, skillId: skill.id, skillVersion: skill.version, responseMode, productVersion: product.version };
      return this.workflows.finish(userId, result, context.session.stateVersion);
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : signal.aborted ? 'REQUEST_CANCELLED' : 'CONSULTATION_FAILED';
      result.diagnostics = { stage: providerStage, code, networkCode: error instanceof ProviderError ? error.details?.networkCode ?? null : null,
        host: error instanceof ProviderError ? error.details?.host ?? null : null, attempts: error instanceof ProviderError ? error.details?.attempts ?? 1 : 1 };
      console.error(JSON.stringify({ event: 'consultation_provider_failure', runId: result.runId, ...result.diagnostics }));
      this.workflows.event(begun.runId, 'error', '处理异常或取消', { 阶段: providerStage, 错误: code, 网络代码: result.diagnostics.networkCode });
      result.warnings.push(code);
      if (!result.route) saveRoute(baseRoute(config, code));
      if (externalSignal?.aborted || controller.signal.aborted) {
        result.status = 'cancelled';
        return this.workflows.finish(userId, result, context.session.stateVersion);
      }
      const providerName = providerStage === 'jev' ? 'Jev 调度服务' : '回复模型服务';
      const detail = result.diagnostics.networkCode ? ` / ${result.diagnostics.networkCode}` : '';
      const message = !router.configured || !generator.configured
        ? '尚未配置完整模型连接。请打开“业务配置”，填写TypeSafe和回复模型API Key并点击“验证连接”，然后新发一条咨询。'
        : code.includes('401') ? `${providerName}拒绝了密钥，请在“业务配置”核对API Key并验证连接。`
        : code.includes('429') ? `${providerName}暂时限流，请稍后再试，或选择人工服务。`
        : code.startsWith('CHAT_INVALID') || code.startsWith('CHAT_MISSING') || code === 'CHAT_TRUNCATED' ? `回复模型已返回内容，但格式或引用未通过校验，暂不展示该回复。可以重新提问或请求人工。（${code}）`
        : `${providerName}暂时连接失败，您的消息已保存。请在“业务配置”验证连接后重新发送一条消息。（${code}${detail}）`;
      return finishTemplate('degraded', message);
    } finally {
      if (this.active.get(sessionId) === controller) this.active.delete(sessionId);
    }
  }
}
