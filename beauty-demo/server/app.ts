import express, { type ErrorRequestHandler, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { idSchema, createSessionSchema } from './contracts/index.js';
import { AppError } from './core/errors.js';
import { Store } from './storage/store.js';
import { CustomerService } from './core/customer-service.js';
import { resolve } from 'node:path';

const param = (req: Request, name: string) => idSchema.parse(req.params[name]);
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export function createApp(store: Store, service = new CustomerService(store)) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.locals.traceId = randomUUID();
    res.setHeader('X-Trace-Id', res.locals.traceId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Local demo: do not accept browser requests originating from another site.
  // User IDs select local demo identities; this is not a production login system.
  app.use((req, _res, next) => {
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host || origin.protocol !== 'http:') throw new Error('origin');
      } catch {
        throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Cross-origin browser access is disabled');
      }
    }
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  app.use('/demo', express.static(resolve('web'), { index: 'index.html' }));

  app.get('/', (_req, res) => res.json({
    name: '美妆客服 Demo — 数据底座',
    phase: 'foundation',
    implemented: ['product_knowledge', 'comment_import', 'user_cards', 'sessions', 'message_storage'],
    workflow: '/api/status', demo: '/demo/',
    pending: ['reviewed_business_content', 'real_model_acceptance', '50_gold_cases'],
    health: '/health',
  }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', ...store.health() }));
  app.get('/api/status', (_req, res) => res.json(service.status()));
  app.get('/api/products', (_req, res) => res.json({ items: store.listProducts() }));
  app.post('/api/imports/products', (req, res) => res.json(store.importProduct(req.body)));
  app.get('/api/products/:productId/knowledge', (req, res) => res.json(store.getKnowledge(param(req, 'productId'))));
  app.post('/api/imports/comments', (req, res) => res.json(store.importComments(req.body)));
  app.get('/api/products/:productId/comments', (req, res) => {
    const { limit, offset } = pagination.parse(req.query);
    res.json(store.listComments(param(req, 'productId'), limit, offset));
  });
  app.get('/api/users', (_req, res) => res.json({ items: store.listUsers() }));
  app.post('/api/users', (req, res) => res.status(201).json(store.createUser(req.body)));
  app.get('/api/users/:userId/card', (req, res) => res.json(store.getCard(param(req, 'userId'))));
  app.patch('/api/users/:userId/card', (req, res) => res.json(store.updateCard(param(req, 'userId'), req.body)));
  app.post('/api/users/:userId/sessions', (req, res) => {
    const { productId } = createSessionSchema.parse(req.body);
    res.status(201).json(store.createSession(param(req, 'userId'), productId));
  });
  app.get('/api/users/:userId/sessions', (req, res) => res.json({ items: store.listSessions(param(req, 'userId')) }));
  app.get('/api/users/:userId/sessions/:sessionId/context', (req, res) =>
    res.json(store.getContext(param(req, 'userId'), param(req, 'sessionId'))));
  app.get('/api/users/:userId/sessions/:sessionId/messages', (req, res) => {
    const { limit, offset } = pagination.parse(req.query);
    res.json(store.listMessages(param(req, 'userId'), param(req, 'sessionId'), limit, offset));
  });
  app.post('/api/users/:userId/sessions/:sessionId/messages', (req, res) => {
    const result = store.appendUserMessage(param(req, 'userId'), param(req, 'sessionId'), req.body);
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.post('/api/users/:userId/sessions/:sessionId/consult', async (req, res) => {
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', onClose);
    try { res.json(await service.consult(param(req, 'userId'), param(req, 'sessionId'), req.body, abort.signal)); }
    finally { res.off('close', onClose); }
  });
  app.get('/api/users/:userId/sessions/:sessionId/runs/:requestId', (req, res) =>
    res.json(service.workflows.result(param(req, 'userId'), param(req, 'sessionId'), param(req, 'requestId'))));
  app.post('/api/users/:userId/sessions/:sessionId/handoff', (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(req.body);
    res.json(service.requestHandoff(param(req, 'userId'), param(req, 'sessionId'), reason));
  });
  app.post('/api/users/:userId/messages/:messageId/feedback', (req, res) =>
    res.json(service.feedback(param(req, 'userId'), param(req, 'messageId'), req.body)));
  // Local demo operator endpoints: not exposed as user-side MCP tools.
  app.get('/api/handoffs', (_req, res) => res.json({ items: service.workflows.listHandoffs() }));
  app.get('/api/handoffs/:handoffId', (req, res) => res.json(service.workflows.getHandoff(param(req, 'handoffId'))));
  app.post('/api/handoffs/:handoffId/claim', (req, res) => res.json(service.workflows.claim(param(req, 'handoffId'))));
  app.post('/api/handoffs/:handoffId/reply', (req, res) => res.json(service.workflows.humanReply(param(req, 'handoffId'), req.body)));
  app.post('/api/handoffs/:handoffId/resolve', (req, res) => res.json(service.workflows.resolve(param(req, 'handoffId'))));
  app.get('/api/dashboard', (_req, res) => res.json(service.workflows.dashboard()));
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found')));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const traceId = res.locals.traceId as string;
    if (error instanceof ZodError) {
      res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Input validation failed', traceId,
        issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) } });
    } else if (error instanceof AppError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, traceId } });
    } else if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body', traceId } });
    } else if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request exceeds 8 MB', traceId } });
    } else {
      console.error(JSON.stringify({ event: 'request_failed', traceId, errorType: error instanceof Error ? error.name : 'unknown' }));
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', traceId } });
    }
  };
  app.use(errors);
  return app;
}
