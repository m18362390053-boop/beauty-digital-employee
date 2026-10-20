import type { Express } from 'express';
import { z } from 'zod';
import { AccessControl } from './access.js';
import { Store } from './storage/store.js';
import { CustomerService } from './core/customer-service.js';
import { createSessionSchema, idSchema } from './contracts/index.js';
import type { ConsultResult } from './core/workflow-types.js';
import { VideoMomentService, videoMomentDataRoot, videoMomentRequestSchema } from './core/video-moment.js';
import { Routines } from './core/routines.js';
import { AppError } from './core/errors.js';
import { ProductVision } from './core/product-vision.js';
import { ProviderError } from './core/providers.js';
import { SpeechService } from './core/speech.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { recognizeProductLabel } from './core/product-ocr.js';

const friendlyFailure = '当前智能客服暂时无法完成回复。您的消息已保存，可以稍后重试或请求人工。';
const skincareScheduleSchema = z.object({
  products: z.array(z.record(z.string(), z.unknown())).max(300),
  checks: z.record(z.string(), z.record(z.string(), z.boolean())),
  observations: z.record(z.string(), z.unknown()),
  ocrDraft: z.object({
    candidates: z.array(z.string().max(80)).max(8), recognizedAt: z.string().datetime(),
    caseId: z.string().max(30).optional(), caseName: z.string().max(100).optional(), caseCategory: z.string().max(30).optional(),
    caseArea: z.string().max(80).optional(), casePeriod: z.enum(['morning', 'evening', 'both']).optional(), casePaoLabel: z.string().max(200).optional(),
    caseSource: z.string().max(120).optional(), caseSourceUrl: z.string().url().max(500).optional(), caseConflict: z.string().max(500).optional(),
  }).strict().nullable().optional(),
}).strict().refine(value => JSON.stringify(value).length <= 2_000_000, '护肤日程数据过大');
function requireScheduleShare(input: unknown) {
  const supplied = z.string().min(32).max(128).parse(input);
  const expected = process.env.BEAUTY_SCHEDULE_SHARE_TOKEN ?? '';
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  if (b.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(403, 'SCHEDULE_SHARE_INVALID', '护肤日程共享链接无效。');
  return supplied;
}
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
export function mountCustomerApi(app: Express, store: Store, service: CustomerService, access: AccessControl,
  routines = new Routines(store), vision = new ProductVision(store, service.modelSettings), speech = new SpeechService()) {
  const videoMoments = new VideoMomentService(videoMomentDataRoot(store.path));
  const audit = (userId: string, modality: 'image' | 'asr' | 'tts', provider: string, status: 'succeeded' | 'failed', error?: unknown) => {
    const code = error instanceof AppError || error instanceof ProviderError ? error.code : error ? 'UPSTREAM_FAILURE' : null;
    store.db.prepare(`INSERT INTO modality_events(id,user_id,modality,provider,status,code,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(randomUUID(), userId, modality, provider, status, code, new Date().toISOString());
  };
  app.use('/api/customer', (req, res, next) => {
    try { res.locals.customerUserId = access.requireCustomer(req).userId; next(); } catch (error) { next(error); }
  });
  app.get('/api/customer/bootstrap', (_req, res) => res.json({
    products: store.listProducts(), card: store.getCard(res.locals.customerUserId),
    serviceAvailable: service.status().providers.jevConfigured && service.status().providers.chatConfigured,
  }));
  app.get('/api/customer/card', (_req, res) => res.json(store.getCard(res.locals.customerUserId)));
  app.get('/api/customer/skincare-schedule', (req, res) => {
    const shareToken = requireScheduleShare(req.query.share);
    res.json(store.getSkincareSchedule(shareToken) ?? { document: null, updatedAt: null });
  });
  app.put('/api/customer/skincare-schedule', (req, res) => {
    const shareToken = requireScheduleShare(req.body?.share);
    const document = skincareScheduleSchema.parse(req.body?.document);
    res.json(store.saveSkincareSchedule(shareToken, document));
  });
  app.post('/api/customer/product-ocr', async (req, res) => res.json(await recognizeProductLabel(req.body)));
  app.patch('/api/customer/card', (req, res) => res.json(store.updateCard(res.locals.customerUserId, req.body)));
  app.get('/api/customer/input/capabilities', (_req, res) => res.json({
    typedText: 'available', packagingTextMatch: 'available', screenButtons: 'available',
    asr: speech.settings.asrReady() ? 'configured_unverified' : 'not_configured',
    tts: speech.settings.ttsReady() ? 'configured_unverified' : 'not_configured',
    imageRecognition: vision.configured() ? 'configured_unverified' : 'not_configured',
    imageProvider: vision.provider(),
  }));
  app.post('/api/customer/speech/transcribe', async (req, res) => {
    const abort = new AbortController(); const close = () => { if (!res.writableEnded) abort.abort(); }; res.on('close', close);
    try { const result = await speech.transcribe(req.body, abort.signal); audit(res.locals.customerUserId, 'asr', 'volcano_ark', 'succeeded'); res.json(result); }
    catch (error) { if (error instanceof ProviderError || error instanceof AppError) audit(res.locals.customerUserId, 'asr', 'volcano_ark', 'failed', error);
      if (!(error instanceof ProviderError)) throw error;
      throw new AppError(503, error.code, '转写服务暂不可用；没有执行任何指令。');
    } finally { res.off('close', close); }
  });
  app.post('/api/customer/speech/synthesize', async (req, res) => {
    const abort = new AbortController(); const close = () => { if (!res.writableEnded) abort.abort(); }; res.on('close', close);
    try {
      const source = z.object({ authorized: z.literal(true), messageId: idSchema.optional(), routineId: idSchema.optional() }).strict()
        .refine(value => Number(Boolean(value.messageId)) + Number(Boolean(value.routineId)) === 1, 'Choose one owned text source').parse(req.body);
      let text: string;
      if (source.routineId) {
        const run = routines.get(res.locals.customerUserId, source.routineId);
        if (run.status !== 'active' || !run.current) throw new AppError(409, 'ROUTINE_NOT_ACTIVE', '没有可朗读的当前步骤。');
        text = run.current.instruction;
      } else {
        const row = store.db.prepare(`SELECT m.role,m.content,m.metadata FROM messages m
          JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND s.user_id=?`)
          .get(source.messageId!, res.locals.customerUserId) as { role: string; content: string; metadata: string } | undefined;
        if (!row || !['assistant', 'human'].includes(row.role)
          || ['degraded', 'cancelled', 'interrupted'].includes((JSON.parse(row.metadata) as { status?: string }).status ?? '')) {
          throw new AppError(404, 'SPEAK_SOURCE_NOT_FOUND', '没有可朗读的本人回复。');
        }
        text = row.content;
      }
      const result = await speech.synthesize({ authorized: true, text }, abort.signal);
      audit(res.locals.customerUserId, 'tts', 'doubao_voice', 'succeeded'); res.json(result);
    }
    catch (error) { if (error instanceof ProviderError || error instanceof AppError) audit(res.locals.customerUserId, 'tts', 'doubao_voice', 'failed', error);
      if (!(error instanceof ProviderError)) throw error;
      throw new AppError(503, error.code, '播报服务暂不可用，请阅读页面文字。');
    } finally { res.off('close', close); }
  });
  app.post('/api/customer/packaging/candidates', (req, res) => res.json(routines.candidates(req.body)));
  app.post('/api/customer/packaging/recognize', async (req, res) => {
    const abort = new AbortController();
    const close = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', close);
    try { const provider = vision.provider() ?? 'not_configured'; const result = await vision.recognize(req.body, abort.signal);
      audit(res.locals.customerUserId, 'image', provider, 'succeeded'); res.json(result); }
    catch (error) {
      if (error instanceof ProviderError || error instanceof AppError) audit(res.locals.customerUserId, 'image', vision.provider() ?? 'not_configured', 'failed', error);
      if (!(error instanceof ProviderError)) throw error;
      throw new AppError(503, error.code, '图片识别服务暂不可用，未确认任何产品。请稍后重试或改用文字输入。');
    } finally { res.off('close', close); }
  });
  app.get('/api/customer/routines/products', (_req, res) => res.json({ items: routines.eligibleProducts() }));
  app.get('/api/customer/routines/current', (_req, res) => res.json({ routine: routines.current(res.locals.customerUserId) }));
  app.post('/api/customer/routines', (req, res) => res.status(201).json(routines.start(res.locals.customerUserId, req.body)));
  app.get('/api/customer/routines/:routineId', (req, res) =>
    res.json(routines.get(res.locals.customerUserId, idSchema.parse(req.params.routineId))));
  app.post('/api/customer/routines/:routineId/actions', (req, res) => {
    if (req.body?.source === 'device_button') throw new AppError(403, 'DEVICE_SOURCE_REQUIRED', '设备按钮只接受设备连接凭据。');
    res.json(routines.act(res.locals.customerUserId, idSchema.parse(req.params.routineId), req.body));
  });
  app.post('/api/customer/routines/:routineId/text-commands', (req, res) =>
    res.json(routines.typedCommand(res.locals.customerUserId, idSchema.parse(req.params.routineId), req.body)));
  app.get('/api/customer/care-events', (_req, res) => res.json({ items: routines.events(res.locals.customerUserId) }));
  app.delete('/api/customer/care-events/:eventId', (req, res) =>
    res.json(routines.voidEvent(res.locals.customerUserId, idSchema.parse(req.params.eventId))));
  app.post('/api/customer/video-moments', async (req, res) => {
    const result = await videoMoments.create(res.locals.customerUserId, videoMomentRequestSchema.parse(req.body));
    res.status(201).json(result);
  });
  app.get('/api/customer/video-moments', async (_req, res) => res.json(await videoMoments.list(res.locals.customerUserId)));
  app.delete('/api/customer/video-moments/:jobId', async (req, res) =>
    res.json(await videoMoments.delete(res.locals.customerUserId, req.params.jobId)));
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
