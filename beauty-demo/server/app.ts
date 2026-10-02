import express, { type ErrorRequestHandler, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { idSchema, createSessionSchema } from './contracts/index.js';
import { AppError } from './core/errors.js';
import { Store } from './storage/store.js';
import { CustomerService } from './core/customer-service.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { SkillPackages } from './core/skill-packages.js';
import { AccessControl } from './access.js';
import { mountCustomerApi } from './customer-api.js';
import { skillVersionSchema } from './core/workflow-types.js';

const param = (req: Request, name: string) => idSchema.parse(req.params[name]);
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export function createApp(store: Store, service = new CustomerService(store), options: { access?: AccessControl } = {}) {
  const app = express();
  const access = options.access ?? new AccessControl(store);
  app.disable('x-powered-by');
  if (process.env.BEAUTY_TRUST_PROXY === '1') app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.locals.traceId = randomUUID();
    res.setHeader('X-Trace-Id', res.locals.traceId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use((req, _res, next) => {
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host || origin.protocol !== `${req.protocol}:`) throw new Error('origin');
      } catch {
        throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Cross-origin browser access is disabled');
      }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Cross-site requests are disabled');
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  app.use('/chat', express.static(resolve('web/customer'), { index: 'index.html' }));
  app.use('/ops', express.static(resolve('web/operator'), { index: 'index.html' }));
  app.use('/shared', express.static(resolve('web/shared')));

  app.get('/', (_req, res) => res.redirect('/chat/'));
  app.get(['/demo', '/demo/'], (_req, res) => res.redirect('/ops/'));
  app.get('/health', (_req, res) => res.json({ status: 'ok', ...store.health() }));
  app.get('/api/auth/customer/status', (req, res) => res.json(access.customerStatus(req)));
  app.post('/api/auth/customer/start', (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.json(access.startCustomer(req, res));
  });
  app.get('/api/auth/operator/status', (req, res) => res.json(access.operatorStatus(req)));
  app.post('/api/auth/operator/login', (req, res) => {
    const { password } = z.object({ password: z.string().min(1).max(1024) }).strict().parse(req.body);
    res.json(access.login(req, res, password));
  });
  app.post('/api/auth/operator/logout', (req, res) => { access.logout(req, res); res.json({ authenticated: false }); });
  mountCustomerApi(app, store, service, access);
  app.use('/api', access.guard);
  app.post('/api/ops/mcp-credentials', (req, res) => {
    const { userId } = z.object({ userId: idSchema }).strict().parse(req.body);
    res.json(access.issueMcp(userId));
  });
  app.get('/api/status', (_req, res) => res.json(service.status()));
  app.post('/api/setup/demo', (_req, res) => {
    if (store.listProducts().some(p => p.productId !== 'demo-product' || p.dataKind !== 'demo')) {
      throw new AppError(409, 'BUSINESS_DATA_PRESENT', '已有业务产品，不能导入演示产品覆盖。');
    }
    const load = (name: string) => JSON.parse(readFileSync(resolve('content/templates', name), 'utf8'));
    store.importProduct(load('product.demo.json'));
    store.importComments(load('comments.demo.json'));
    const users = store.listUsers();
    for (const userId of ['demo-user-a', 'demo-user-b']) if (!users.some(user => user.userId === userId)) store.createUser({ userId, displayName: `演示用户 ${userId.slice(-1).toUpperCase()}` });
    res.json({ status: 'ready', dataKind: 'demo' });
  });
  app.get('/api/settings/models', (_req, res) => res.json(service.modelSettings.publicView()));
  app.put('/api/settings/models', (req, res) => res.json(service.configureModels(req.body)));
  app.post('/api/settings/models/check', async (_req, res) => res.json(await service.checkModels()));
  app.get('/api/skills', (_req, res) => res.json({ items: service.skills.list(), intents: service.config.intents }));
  app.get('/api/skills/:skillId/versions', (req, res) => res.json(service.skills.versions(param(req, 'skillId'))));
  app.get('/api/skills/:skillId/versions/:version', (req, res) => res.json(service.skills.document(param(req, 'skillId'), skillVersionSchema.parse(req.params.version))));
  app.get('/api/skills/:skillId/versions/:version/export', (req, res) => {
    const id = param(req, 'skillId'); const version = skillVersionSchema.parse(req.params.version);
    res.setHeader('Content-Disposition', `attachment; filename="${id}-${version}.zip"`);
    res.type('application/zip').send(Buffer.from(service.skills.exportVersion(id, version)));
  });
  app.post('/api/skills/:skillId/activate', (req, res) => {
    const body = z.object({ version: skillVersionSchema, expectedCurrentVersion: skillVersionSchema }).strict().parse(req.body);
    res.json(service.skills.activate(param(req, 'skillId'), body.version, body.expectedCurrentVersion));
  });
  app.post('/api/skills/import', (req, res) => res.json(service.skills.import(req.body)));
  app.patch('/api/skills/:skillId', (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(service.skills.enable(param(req, 'skillId'), enabled));
  });
  app.get('/api/skills/template.zip', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="beauty-skill-template.zip"');
    res.type('application/zip').send(Buffer.from(SkillPackages.template()));
  });
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
  app.get('/api/ops/runs', (_req, res) => res.json({ items: service.workflows.listRuns() }));
  app.get('/api/ops/runs/:runId', (req, res) => res.json(service.workflows.runDetail(param(req, 'runId'))));
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
