import type { Express } from 'express';
import { z } from 'zod';
import { AccessControl } from './access.js';
import { Store } from './storage/store.js';
import { CustomerService } from './core/customer-service.js';
import { createSessionSchema, idSchema } from './contracts/index.js';
import type { ConsultResult } from './core/workflow-types.js';

const friendlyFailure = '当前智能客服暂时无法完成回复。您的消息已保存，可以稍后重试或请求人工。';
function sessionTopic(text: string) {
  if (/眼周|卧蚕|眼袋|法令纹|T区|额头|鼻翼|脸颊|下巴|涂.{0,4}(?:哪|位置)|(?:哪|哪里|哪儿).{0,4}涂|使用.{0,5}(?:位置|部位)|起皮|死皮|部位|区域|位置/.test(text)) return '面部位置与用法';
  if (/退货|退款|物流|快递|投诉|售后/.test(text)) return '售后服务';
  if (/产品|商品|眼霜|面霜|精华|成分|品牌|适合我|价格|推荐/.test(text)) return '产品咨询';
  if (/刺激|紧绷|刺痛|泛红|肤感|过敏|不舒服|效果/.test(text)) return '使用感受';
  return '日常护肤';
}
function sessionSummary(text?: string) {
  const cleaned = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '新咨询';
  return cleaned.length > 44 ? `${cleaned.slice(0, 44)}…` : cleaned;
}
export function publicResult(result: ConsultResult | null, service?: CustomerService) {
  if (!result) return null;
  return { requestId: result.requestId, sessionId: result.sessionId, messageId: result.messageId, status: result.status,
    answer: result.status === 'degraded' ? friendlyFailure : result.answer, sources: service?.workflows.publicSources(result.runId, result.sourceRefs) ?? [],
    productCards: result.status === 'answered' ? result.productCards ?? [] : [], dataKind: result.dataKind,
    visualGuide: result.visualGuide ?? null,
    message: ({ answered: '已完成回复', clarification_required: '需要补充信息', degraded: '智能服务暂不可用', handoff_pending: '正在等待人工', human_active: '人工已接入', resolved: '本次服务已结束', cancelled: '已停止处理', interrupted: '处理已中止' })[result.status] };
}
export function mountCustomerApi(app: Express, store: Store, service: CustomerService, access: AccessControl) {
  app.use('/api/customer', (req, res, next) => {
    try { res.locals.customerUserId = access.requireCustomer(req).userId; next(); } catch (error) { next(error); }
  });
  app.get('/api/customer/bootstrap', (_req, res) => res.json({
    products: store.listProducts(), card: store.getCard(res.locals.customerUserId),
    serviceAvailable: service.status().providers.jevConfigured && service.status().providers.chatConfigured,
  }));
  app.get('/api/customer/card', (_req, res) => res.json(store.getCard(res.locals.customerUserId)));
  app.patch('/api/customer/card', (req, res) => res.json(store.updateCard(res.locals.customerUserId, req.body)));
  app.get('/api/customer/sessions', (_req, res) => res.json({ items: store.listSessions(res.locals.customerUserId).map((session: any) => {
    const { userId: _userId, firstUserMessage, latestUserMessage, ...publicSession } = session;
    return { ...publicSession, topic: sessionTopic(firstUserMessage ?? ''), summary: sessionSummary(firstUserMessage),
      preview: sessionSummary(latestUserMessage ?? firstUserMessage) };
  }) }));
  app.post('/api/customer/sessions', (req, res) => {
    const { productId } = createSessionSchema.parse(req.body);
    res.status(201).json(store.createSession(res.locals.customerUserId, productId));
  });
  app.get('/api/customer/sessions/:sessionId/messages', (req, res) => {
    const id = idSchema.parse(req.params.sessionId);
    const pagination = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }).strict().parse(req.query);
    const session = store.getSession(res.locals.customerUserId, id);
    const messages = store.listMessages(res.locals.customerUserId, id, pagination.limit, pagination.offset);
    res.json({ session: { sessionId: session.sessionId, status: session.status }, ...messages, items: messages.items.map(message => {
      const metadata = message.metadata as { runId?: string; status?: string; sourceRefs?: string[];
        productCards?: ConsultResult['productCards']; visualGuide?: ConsultResult['visualGuide']; dataKind?: string };
      // Warnings can describe a successful, usable fallback (for example Jev being
      // unavailable while the reply model still answered). Only terminal failure states
      // should replace the saved answer with the generic failure copy.
      const failed = ['degraded', 'cancelled', 'interrupted'].includes(metadata.status ?? '');
      return { messageId: message.messageId, role: message.role, content: message.role === 'assistant' && failed ? friendlyFailure : message.content,
        createdAt: message.createdAt, sources: metadata.runId ? service.workflows.publicSources(metadata.runId, metadata.sourceRefs ?? []) : [],
        productCards: failed ? [] : metadata.productCards ?? [], visualGuide: metadata.visualGuide ?? null, dataKind: metadata.dataKind };
    }) });
  });
  app.post('/api/customer/sessions/:sessionId/consult', async (req, res) => {
    const signal = new AbortController();
    const close = () => { if (!res.writableEnded) signal.abort(); };
    res.on('close', close);
    try { res.json(publicResult(await service.consult(res.locals.customerUserId, idSchema.parse(req.params.sessionId), req.body, signal.signal), service)); }
    finally { res.off('close', close); }
  });
  app.get('/api/customer/sessions/:sessionId/runs/:requestId', (req, res) => {
    const run = service.workflows.result(res.locals.customerUserId, idSchema.parse(req.params.sessionId), idSchema.parse(req.params.requestId));
    res.json({ state: run.state, result: publicResult(run.result, service) });
  });
  app.post('/api/customer/sessions/:sessionId/handoff', (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(req.body);
    const handoff = service.requestHandoff(res.locals.customerUserId, idSchema.parse(req.params.sessionId), reason);
    res.json({ status: handoff.status, message: handoff.status === 'active' ? '人工已接入' : '已加入人工队列，请稍候。' });
  });
  app.post('/api/customer/messages/:messageId/feedback', (req, res) => {
    const feedback = service.feedback(res.locals.customerUserId, idSchema.parse(req.params.messageId), req.body);
    res.json({ nextAction: feedback.nextAction, prompt: 'prompt' in feedback ? feedback.prompt : '已为您请求人工服务。' });
  });
}
