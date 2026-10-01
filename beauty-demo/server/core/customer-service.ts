import { Store } from '../storage/store.js';
import { Workflows } from '../storage/workflows.js';
import { userMessageSchema } from '../contracts/index.js';
import { AppError } from './errors.js';
import { baseRoute, loadBusinessConfig, ruleRoute } from './registry.js';
import { ChatProvider, JevProvider, ProviderError } from './providers.js';
import type { BusinessConfig, ConsultResult, DecisionProvider, GenerationProvider, RouteRecord } from './workflow-types.js';

export class CustomerService {
  readonly workflows: Workflows;
  readonly config: BusinessConfig;
  private router: DecisionProvider;
  private generator: GenerationProvider;
  private active = new Map<string, AbortController>();
  constructor(readonly store: Store, options: { config?: BusinessConfig; router?: DecisionProvider; generator?: GenerationProvider } = {}) {
    this.workflows = new Workflows(store);
    this.config = options.config ?? loadBusinessConfig();
    this.router = options.router ?? new JevProvider();
    this.generator = options.generator ?? new ChatProvider();
  }
  status() {
    return { phase: 'workflow_demo', policyVersion: this.config.version, policyStatus: this.config.reviewStatus,
      notice: this.config.notice, providers: { jevConfigured: this.router.configured, chatConfigured: this.generator.configured },
      skills: this.config.skills.map(({ instructions: _instructions, ...definition }) => definition),
      intents: this.config.intents, riskLevels: this.config.riskLevels, maxConsultationMs: 45_000 };
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
    const initial = this.store.getSession(userId, sessionId);
    try {
      const prior = this.workflows.result(userId, sessionId, message.requestId);
      this.store.appendUserMessage(userId, sessionId, message);
      if (prior.result) return prior.result;
      throw new AppError(409, 'CONSULTATION_IN_PROGRESS', 'Request is already running');
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'RUN_NOT_FOUND')) throw error;
    }
    const explicit = initial.status === 'RESOLVED' ? null : ruleRoute(message.content, this.config);
    let handoff: ReturnType<Workflows['getHandoff']> | null = null;
    if (explicit) {
      this.store.appendUserMessage(userId, sessionId, message);
      handoff = this.requestHandoff(userId, sessionId, explicit.route.ruleHits.join(','));
    }
    const begun = this.workflows.begin(userId, sessionId, message);
    if (begun.cached) return begun.cached;
    const context = this.store.getContext(userId, sessionId);
    const product = this.store.getKnowledge(context.session.productId);
    const result: ConsultResult = {
      runId: begun.runId, requestId: message.requestId, sessionId, status: 'degraded', answer: null, answerKind: 'none',
      messageId: null, sourceRefs: [], route: null, warnings: [], policyStatus: this.config.reviewStatus, dataKind: product.dataKind,
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
      saveRoute(baseRoute(this.config, 'HUMAN_OR_CLOSED_SESSION'));
      const status = context.session.status === 'RESOLVED' ? 'resolved' : context.session.status === 'HUMAN_ACTIVE' ? 'human_active' : 'handoff_pending';
      return finishTemplate(status, status === 'resolved' ? '此会话已结束，请新建会话继续咨询。' : this.config.templates.waiting, false);
    }
    if (product.dataKind === 'business' && this.config.reviewStatus !== 'reviewed') {
      saveRoute(baseRoute(this.config, 'BUSINESS_CONFIG_NOT_REVIEWED'));
      result.warnings.push('BUSINESS_CONFIG_NOT_REVIEWED');
      return finishTemplate('degraded', '业务配置尚未审核，暂不能自动回答，请联系人工核实。');
    }
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    const deadline = AbortSignal.timeout(45_000);
    const signal = AbortSignal.any([controller.signal, deadline, ...(externalSignal ? [externalSignal] : [])]);
    try {
      signal.throwIfAborted();
      const decisionInput = { userText: message.content, card: context.card, recentMessages: context.recentMessages.map(m => ({ role: m.role, content: m.content })) };
      const route = await this.router.decide(decisionInput, this.config, signal);
      signal.throwIfAborted();
      saveRoute(route);
      if (route.action === 'handoff' || route.riskLevel === 'high' || route.needsHumanHandoff) {
        handoff = this.workflows.requestHandoff(userId, sessionId, route.reasonCodes.join(','), begun.runId);
        result.handoffId = handoff.id;
        return finishTemplate('handoff_pending', this.config.templates.risk, false);
      }
      if (route.action !== 'answer') return finishTemplate('clarification_required', this.config.templates.clarify);
      const skill = this.config.skills.find(s => s.id === route.primarySkill);
      if (!skill) throw new ProviderError('UNKNOWN_SKILL');
      const facts = product.facts.filter(fact => fact.category === 'after_sales' ? skill.knowledgeScopes.includes('after_sales') : skill.knowledgeScopes.includes('product'));
      const usedSources = new Set(facts.map(fact => fact.sourceId));
      const knowledge = { ...product, facts, sources: product.sources.filter(source => usedSources.has(source.sourceId)) };
      if (!facts.length) {
        result.warnings.push('INSUFFICIENT_EVIDENCE');
        return finishTemplate('clarification_required', this.config.templates.noKnowledge);
      }
      const comments = skill.knowledgeScopes.includes('comment_insights') ? this.store.listComments(product.productId, 20, 0).items : [];
      const generated = await this.generator.generate({ ...decisionInput, skill, knowledge, comments }, signal);
      signal.throwIfAborted();
      result.answer = generated.answer;
      result.answerKind = 'generated'; result.status = 'answered'; result.sourceRefs = generated.sourceRefs;
      result.generation = { model: generated.model, usage: generated.usage, skillId: skill.id, skillVersion: skill.version, productVersion: product.version };
      return this.workflows.finish(userId, result, context.session.stateVersion);
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : signal.aborted ? 'REQUEST_CANCELLED' : 'CONSULTATION_FAILED';
      result.warnings.push(code);
      if (!result.route) saveRoute(baseRoute(this.config, code));
      if (externalSignal?.aborted || controller.signal.aborted) {
        result.status = 'cancelled';
        return this.workflows.finish(userId, result, context.session.stateVersion);
      }
      return finishTemplate('degraded', this.config.templates.unavailable);
    } finally {
      if (this.active.get(sessionId) === controller) this.active.delete(sessionId);
    }
  }
}
