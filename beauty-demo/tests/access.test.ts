import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/storage/store.js';
import { CustomerService } from '../server/core/customer-service.js';
import { baseRoute, loadBusinessConfig } from '../server/core/registry.js';
import { createApp } from '../server/app.js';
import { testAccess, loginOperator, testOperatorPassword } from './access-helper.js';
import { parseSkillUpload } from '../server/core/skill-packages.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-access-'));
  const store = new Store(join(dir, 'test.sqlite'));
  store.importProduct(JSON.parse(await readFile(resolve('content/templates/product.demo.json'), 'utf8')));
  const config = loadBusinessConfig();
  const service = new CustomerService(store, { config,
    router: { configured: true, decide: async (_input, cfg) => {
      const skill = cfg.skills.find(s => s.id === 'version-guide');
      return { ...baseRoute(cfg, 'TEST_ONLY'), routeStatus: 'jev', intent: 'product_advice', riskLevel: 'low',
        primarySkill: skill?.id ?? 'product_consult', action: 'answer', model: 'test-jev' };
    } },
    generator: { configured: true, generate: async input => ({ answer: `实际文档 ${input.skill.id} ${input.skill.version}: ${input.skill.instructions}`,
      sourceRefs: input.knowledge.sources.map(s => s.sourceId), model: 'test-chat', usage: { input_tokens: 1 } }) },
  });
  const access = testAccess(store); const server = createApp(store, service, { access }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); }); store.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  const customer = async () => {
    const response = await request('/api/auth/customer/start', 'POST', {});
    const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    return { userId: response.body.userId as string, headers: { Cookie: cookie.split(';')[0]!, 'X-CSRF-Token': response.body.csrfToken as string } };
  };
  return { store, service, access, base, request, customer };
}

test('anonymous/customer cannot invoke operator endpoints or forge a chosen identity', async t => {
  const f = await fixture(t);
  for (const path of ['/api/status', '/api/settings/models', '/api/users', '/api/skills', '/api/dashboard', '/api/handoffs', '/api/ops/runs']) {
    assert.equal((await f.request(path)).status, 401);
  }
  assert.equal((await f.request('/api/auth/customer/start', 'POST', { userId: 'victim', role: 'operator' })).status, 422);
  const user = await f.customer();
  assert.equal((await f.request('/api/settings/models', 'PUT', { chatModel: 'injected' }, user.headers)).status, 401);
  assert.equal((await f.request('/api/skills/import', 'POST', { filename: 'x.md', content: 'x' }, user.headers)).status, 401);
  assert.equal((await f.request('/api/users', 'GET', undefined, { ...user.headers, 'X-Role': 'operator' })).status, 401);
  const again = await f.request('/api/auth/customer/start', 'POST', {}, user.headers);
  assert.equal(again.body.userId, user.userId);
});

test('customer identity is bound server-side and cannot read/write another browser session', async t => {
  const f = await fixture(t); const a = await f.customer(); const b = await f.customer();
  assert.notEqual(a.userId, b.userId);
  const session = (await f.request('/api/customer/sessions', 'POST', { productId: 'demo-product' }, a.headers)).body;
  await f.request('/api/customer/card', 'PATCH', { expectedVersion: 0, preferences: ['A的偏好'] }, a.headers);
  assert.deepEqual((await f.request('/api/customer/card', 'GET', undefined, b.headers)).body.preferences, []);
  for (const action of ['messages', 'runs/unknown']) assert.equal((await f.request(`/api/customer/sessions/${session.sessionId}/${action}`, 'GET', undefined, b.headers)).status, 404);
  assert.equal((await f.request(`/api/customer/sessions/${session.sessionId}/consult`, 'POST', { requestId: 'bad', content: '替别人发问' }, b.headers)).status, 404);
  assert.equal((await f.request(`/api/customer/sessions/${session.sessionId}/handoff`, 'POST', { reason: '替别人转人工' }, b.headers)).status, 404);
  const result = (await f.request(`/api/customer/sessions/${session.sessionId}/consult`, 'POST', { requestId: 'own', content: '介绍产品' }, a.headers)).body;
  assert.equal((await f.request(`/api/customer/messages/${result.messageId}/feedback`, 'POST', { type: 'helpful' }, b.headers)).status, 404);
});

test('cookie writes require CSRF, cross-origin calls fail, operator logout revokes access', async t => {
  const f = await fixture(t); const customer = await f.customer(); const op = await loginOperator(f.base);
  assert.equal((await f.request('/api/customer/card', 'PATCH', { expectedVersion: 0, preferences: ['x'] }, { Cookie: customer.headers.Cookie })).status, 403);
  assert.equal((await f.request('/api/setup/demo', 'POST', {}, { Cookie: op.Cookie })).status, 403);
  assert.equal((await f.request('/api/setup/demo', 'POST', {}, { ...op, Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.request('/api/settings/models', 'GET', undefined, op)).status, 200);
  assert.equal((await f.request('/api/auth/operator/logout', 'POST', {}, op)).status, 200);
  assert.equal((await f.request('/api/settings/models', 'GET', undefined, op)).status, 401);
  assert.equal((await f.request('/api/customer/card', 'GET', undefined, customer.headers)).status, 200);
});

test('login has no public default; failed attempts are bounded and sessions expire', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/auth/operator/login', 'POST', { password: 'wrong-password' })).status, 401);
  assert.equal((await f.request('/api/auth/operator/login', 'POST', { password: testOperatorPassword })).status, 429);
  const c = await f.customer();
  f.store.db.prepare("UPDATE access_sessions SET expires_at=0 WHERE role='customer'").run();
  assert.equal((await f.request('/api/customer/card', 'GET', undefined, c.headers)).status, 401);
});

test('MCP bearer has only one user scope and cannot become an operator', async t => {
  const f = await fixture(t); const a = await f.customer(); const b = await f.customer();
  const token = f.access.issueMcp(a.userId).token; const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await f.request(`/api/users/${a.userId}/card`, 'GET', undefined, headers)).status, 200);
  assert.equal((await f.request(`/api/users/${b.userId}/card`, 'GET', undefined, headers)).status, 403);
  assert.equal((await f.request('/api/settings/models', 'GET', undefined, headers)).status, 403);
  assert.equal((await f.request('/api/ops/mcp-credentials', 'POST', { userId: b.userId }, headers)).status, 403);
  assert.equal((await f.request('/api/ops/runs', 'GET', undefined, headers)).status, 403);
  f.store.db.prepare('UPDATE api_credentials SET expires_at=0').run();
  assert.equal((await f.request(`/api/users/${a.userId}/card`, 'GET', undefined, headers)).status, 401);
});

test('customer response omits internal risk/model/config fields; operator can see actual evidence', async t => {
  const f = await fixture(t); const customer = await f.customer(); const op = await loginOperator(f.base);
  const session = (await f.request('/api/customer/sessions', 'POST', { productId: 'demo-product' }, customer.headers)).body;
  const response = await f.request(`/api/customer/sessions/${session.sessionId}/consult`, 'POST', { requestId: 'view', content: '介绍产品' }, customer.headers);
  assert.equal(response.status, 200); assert.equal(response.body.status, 'answered');
  for (const hidden of ['route', 'generation', 'diagnostics', 'warnings', 'policyStatus']) assert.equal(response.body[hidden], undefined);
  assert.equal(response.body.sources[0].title, '虚构资料：仅用于验证来源关联');
  const messages = (await f.request(`/api/customer/sessions/${session.sessionId}/messages`, 'GET', undefined, customer.headers)).body;
  assert.equal(messages.items[1].metadata, undefined);
  const list = (await f.request('/api/ops/runs', 'GET', undefined, op)).body.items;
  const detail = (await f.request(`/api/ops/runs/${list[0].runId}`, 'GET', undefined, op)).body;
  assert.ok(detail.events.some((event: { kind: string }) => event.kind === 'profile'));
  assert.equal(detail.snapshot.card.userId, customer.userId);
  assert.equal(detail.snapshot.skill.id, 'product_consult');
  assert.ok(detail.snapshot.knowledge.sources.length > 0);
});

test('skill versions preview/export/activate preserve documents and historical execution snapshots', async t => {
  const f = await fixture(t); const op = await loginOperator(f.base); const customer = await f.customer();
  const sample = { id: 'version-guide', version: '1.0.0', description: '版本化演示说明', intents: ['product_advice'], knowledgeScopes: ['product'], requiredFields: [], requiresKnowledge: true,
    instructions: '  版本A说明\n', knowledge: [{ title: '自定义来源标题', content: '\n这里是知识A。\n' }] };
  const upload = async (skill: unknown) => f.request('/api/skills/import', 'POST', { filename: 'version.json', content: JSON.stringify(skill) }, op);
  assert.equal((await upload(sample)).status, 200);
  const session = (await f.request('/api/customer/sessions', 'POST', { productId: 'demo-product' }, customer.headers)).body;
  await f.request(`/api/customer/sessions/${session.sessionId}/consult`, 'POST', { requestId: 'v1', content: '版本说明' }, customer.headers);
  const firstRun = f.service.workflows.listRuns()[0]!;
  assert.equal((await upload({ ...sample, instructions: '不允许覆盖' })).status, 409);
  assert.equal((await upload({ ...sample, version: '2.0.0', instructions: '版本B说明' })).status, 200);
  await f.request(`/api/customer/sessions/${session.sessionId}/consult`, 'POST', { requestId: 'v2', content: '版本说明' }, customer.headers);
  const second = f.service.workflows.listRuns()[0]!;
  assert.equal(f.service.workflows.runDetail(firstRun.runId).snapshot?.skill.instructions, sample.instructions);
  assert.equal(f.service.workflows.runDetail(second.runId).snapshot?.skill.instructions, '版本B说明');
  const doc = (await f.request('/api/skills/version-guide/versions/1.0.0', 'GET', undefined, op)).body;
  assert.match(doc.markdown, /版本A说明/);
  const exported = await fetch(f.base + '/api/skills/version-guide/versions/1.0.0/export', { headers: op });
  assert.equal(exported.status, 200);
  const imported = parseSkillUpload({ filename: 'roundtrip.zip', encoding: 'base64', content: Buffer.from(await exported.arrayBuffer()).toString('base64') });
  assert.equal(imported.instructions, sample.instructions); assert.deepEqual(imported.knowledge, sample.knowledge);
  assert.equal((await f.request('/api/skills/version-guide/activate', 'POST', { version: '1.0.0', expectedCurrentVersion: '1.0.0' }, op)).status, 409);
  assert.equal((await f.request('/api/skills/version-guide/activate', 'POST', { version: '1.0.0', expectedCurrentVersion: '2.0.0' }, op)).status, 200);
  await f.request(`/api/customer/sessions/${session.sessionId}/consult`, 'POST', { requestId: 'rollback', content: '版本说明' }, customer.headers);
  assert.equal(f.service.workflows.runDetail(f.service.workflows.listRuns()[0]!.runId).snapshot?.skill.version, '1.0.0');
  await f.request('/api/skills/version-guide', 'PATCH', { enabled: false }, op);
  await f.request(`/api/customer/sessions/${session.sessionId}/consult`, 'POST', { requestId: 'disabled', content: '版本说明' }, customer.headers);
  assert.notEqual(f.service.workflows.runDetail(f.service.workflows.listRuns()[0]!.runId).snapshot?.skill.id, 'version-guide');
});
