import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/storage/store.js';
import { Routines } from '../server/core/routines.js';
import { createApp } from '../server/app.js';
import { testAccess, loginOperator } from './access-helper.js';
import { CarePlans } from '../server/core/care-plans.js';

const products = async () => JSON.parse(await readFile(resolve('content/templates/routine.demo.json'), 'utf8')) as unknown[];

test('care flow snapshots approved usage, confirms only once and allows correcting mistaken records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-care-'));
  const store = new Store(join(dir, 'care.sqlite'));
  try {
    for (const product of await products()) store.importProduct(product);
    store.createUser({ userId: 'care-a', displayName: 'A' }); store.createUser({ userId: 'care-b', displayName: 'B' });
    const care = new Routines(store);
    const productIds = ['demo-gentle-cleanser', 'demo-gentle-cream'];
    const start = { requestId: 'begin-1', period: 'evening', productIds, confirmed: true };
    const run = care.start('care-a', start);
    assert.equal(run.steps.length, 2); assert.match(run.current!.instruction, /虚构演示洁面/);
    assert.equal(care.start('care-a', start).routineId, run.routineId);
    assert.throws(() => care.start('care-a', { ...start, requestId: 'begin-2' }), /当前护理流程/);
    assert.throws(() => care.get('care-b', run.routineId), /没有找到/);
    const repeated = care.act('care-a', run.routineId, { requestId: 'repeat-1', expectedStep: 0, action: 'repeat' });
    assert.equal(repeated.currentStep, 0); assert.equal(care.events('care-a').length, 0);
    assert.equal(care.typedCommand('care-a', run.routineId, { requestId: 'text-repeat', expectedStep: 0, text: '再说一遍。' }).currentStep, 0);
    assert.throws(() => care.typedCommand('care-a', run.routineId, { requestId: 'text-unknown', expectedStep: 0, text: '今天几号' }), /未改变护理步骤/);
    const done = { requestId: 'done-1', expectedStep: 0, action: 'confirm', source: 'screen' };
    const first = care.act('care-a', run.routineId, done);
    assert.equal(first.currentStep, 1); assert.ok(first.eventId);
    assert.deepEqual(care.act('care-a', run.routineId, done), first);
    assert.throws(() => care.act('care-a', run.routineId, { ...done, requestId: 'done-late' }), /步骤已变化/);
    assert.throws(() => care.act('care-a', run.routineId, { ...done, action: 'skip' }), /编号已用于其他内容/);
    const final = care.act('care-a', run.routineId, { requestId: 'skip-2', expectedStep: 1, action: 'skip' });
    assert.equal(final.status, 'finished'); assert.equal(final.eventId, null);
    assert.equal(care.events('care-a').length, 1); assert.equal(care.events('care-b').length, 0);
    assert.deepEqual(care.operatorActions().map(action => action.action).sort(), ['confirm', 'repeat', 'repeat', 'skip']);
    assert.equal(care.operatorActions().filter(action => action.eventId).length, 1);
    assert.throws(() => care.voidEvent('care-b', first.eventId!), /没有找到/);
    care.voidEvent('care-a', first.eventId!);
    assert.ok(care.events('care-a')[0]?.voidedAt);
    const second = care.start('care-a', { ...start, requestId: 'begin-3' });
    assert.equal(care.act('care-a', second.routineId, { requestId: 'stop-1', expectedStep: 0, action: 'stop' }).status, 'stopped');
    assert.equal(care.events('care-a').length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('text matching never confirms a product; unreviewed usage cannot become a care step', async () => {
  const store = new Store(':memory:');
  try {
    const product = JSON.parse(await readFile(resolve('content/templates/product.demo.json'), 'utf8'));
    store.importProduct(product); store.createUser({ userId: 'test-user', displayName: 'User' });
    const care = new Routines(store);
    assert.deepEqual(care.candidates({ observedText: product.name }).items, []);
    assert.throws(() => care.start('test-user', { requestId: 'begin-4', period: 'morning', productIds: [product.productId], confirmed: true }), /没有已审核的使用说明/);
    for (const item of await products()) store.importProduct(item);
    assert.equal(care.candidates({ observedText: '看到了虚构演示面霜' }).items[0]?.productId, 'demo-gentle-cream');
    assert.equal(care.current('test-user'), null);
  } finally { store.close(); }
});

test('business care requires an operator-imported period/order/version-bound approval and snapshots its evidence', async () => {
  const store = new Store(':memory:');
  try {
    const [example] = await products() as any[];
    const product = { ...example, productId: 'test-business-product', name: '测试用正式商品', dataKind: 'business', version: 'v1' };
    store.importProduct(product); store.createUser({ userId: 'care-user', displayName: 'User' });
    const care = new Routines(store); const plans = new CarePlans(store);
    const start = { requestId: 'business-start', period: 'evening', productIds: [product.productId], confirmed: true };
    assert.throws(() => care.start('care-user', start), /尚无已审核计划/);
    const plan = { planId: 'test-plan', version: 'v1', period: 'evening', reviewStatus: 'approved', reviewedBy: '测试审核员',
      scope: '仅供本测试中已核对实物的使用者，按标签说明操作。',
      reviewedAt: '2026-10-14T00:00:00Z', reviewSource: { title: '测试用书面审核记录', locator: 'test://review/1' },
      steps: [{ productId: product.productId, productVersion: 'v1', usageFactId: 'demo-cleanser-usage' }] };
    assert.throws(() => plans.import({ ...plan, reviewStatus: 'draft' }));
    assert.throws(() => plans.import({ ...plan, steps: [{ ...plan.steps[0], usageFactId: 'not-reviewed' }] }), /已审核用法/);
    assert.equal(plans.import(plan).status, 'imported'); assert.equal(plans.import(plan).status, 'unchanged');
    assert.throws(() => plans.import({ ...plan, reviewedBy: '另一位审核员' }), /同版本/);
    assert.ok(care.eligibleProducts().some(p => p.productId === product.productId));
    assert.throws(() => care.start('care-user', { ...start, period: 'morning' }), /尚无已审核计划/);
    const run = care.start('care-user', start);
    assert.equal(run.plan?.planId, plan.planId); assert.equal(run.steps[0]?.productVersion, 'v1');
    care.act('care-user', run.routineId, { requestId: 'skip-business', expectedStep: 0, action: 'skip' });
    store.importProduct({ ...product, version: 'v2' });
    assert.throws(() => care.start('care-user', { ...start, requestId: 'new-version' }), /尚无已审核计划/);
    assert.ok(!care.eligibleProducts().some(p => p.productId === product.productId));
    assert.equal(care.get('care-user', run.routineId).plan?.version, 'v1');
  } finally { store.close(); }
});

test('only operators can import reviewed plans; customer cannot approve an unreviewed SKU', async () => {
  const store = new Store(':memory:');
  const product = { ...(await products() as any[])[0], productId: 'test-business', dataKind: 'business' };
  store.importProduct(product);
  const server = createApp(store, undefined, { access: testAccess(store) }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const plan = { planId: 'operator-plan', version: 'v1', period: 'morning', reviewStatus: 'approved',
      scope: '仅供本测试中已核对实物的使用者，按标签说明操作。',
      reviewedBy: '业务审核测试', reviewedAt: '2026-10-14T00:00:00Z', reviewSource: { title: '测试审核记录', locator: 'test://plan/1' },
      steps: [{ productId: product.productId, productVersion: product.version, usageFactId: 'demo-cleanser-usage' }] };
    const auth = await fetch(base + '/api/auth/customer/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const customer = { Cookie: auth.headers.get('set-cookie')!.split(';')[0]!,
      'X-CSRF-Token': (await auth.json() as { csrfToken: string }).csrfToken, 'Content-Type': 'application/json' };
    const post = (headers: Record<string, string>, value = plan) => fetch(base + '/api/ops/care-plans', { method: 'POST', headers, body: JSON.stringify(value) });
    assert.equal((await post(customer)).status, 401);
    const operator = { ...await loginOperator(base), 'Content-Type': 'application/json' };
    assert.equal((await post({ Cookie: operator.Cookie, 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post(operator, { ...plan, reviewStatus: 'draft' })).status, 422);
    assert.equal((await post(operator)).status, 201);
    assert.equal((await fetch(base + '/api/ops/care-plans', { headers: operator })).status, 200);
    const run = await fetch(base + '/api/customer/routines', { method: 'POST', headers: customer,
      body: JSON.stringify({ requestId: 'reviewed-start', period: 'morning', productIds: ['test-business'], confirmed: true }) });
    assert.equal(run.status, 201);
    assert.equal((await run.json() as { plan: { reviewedBy: string } }).plan.reviewedBy, '业务审核测试');
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); store.close();
  }
});

test('HTTP identity isolation: customer actions and device token share care flow without impersonation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-care-api-')); const store = new Store(join(dir, 'api.sqlite'));
  for (const product of await products()) store.importProduct(product);
  const access = testAccess(store); const server = createApp(store, undefined, { access }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const auth = await fetch(base + '/api/auth/customer/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { userId, csrfToken } = await auth.json() as { userId: string; csrfToken: string };
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    const customer = (path: string, method = 'GET', body?: unknown, csrf = csrfToken) => fetch(base + path, {
      method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const path = '/api/customer/routines';
    assert.equal((await customer(path, 'POST', { requestId: 'a', period: 'evening', productIds: ['demo-gentle-cleanser'], confirmed: true }, '')).status, 403);
    const created = await customer(path, 'POST', { requestId: 'a', period: 'evening', productIds: ['demo-gentle-cleanser'], confirmed: true });
    assert.equal(created.status, 201);
    const { routineId } = await created.json() as { routineId: string };
    const ops = await loginOperator(base);
    const tokenResponse = await fetch(base + '/api/ops/device-credentials', { method: 'POST', headers: { ...ops, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
    assert.equal(tokenResponse.status, 200);
    const { token } = await tokenResponse.json() as { token: string };
    const deviceAction = (body: unknown, bearer = token) => fetch(base + `/api/device/routines/${routineId}/actions`, {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const action = { requestId: 'device-1', expectedStep: 0, action: 'confirm' };
    assert.equal((await deviceAction(action, 'invalid')).status, 401);
    assert.equal((await customer(`${path}/${routineId}/actions`, 'POST', { ...action, source: 'device_button' })).status, 403);
    assert.equal((await deviceAction(action)).status, 200);
    assert.equal((await deviceAction(action)).status, 200);
    const events = await (await customer('/api/customer/care-events')).json() as { items: { eventId: string; source: string }[] };
    assert.equal(events.items.length, 1); assert.equal(events.items[0]?.source, 'device_button');
    const timeline = await fetch(base + '/api/ops/care-events', { headers: ops });
    assert.equal(timeline.status, 200);
    assert.equal(((await timeline.json() as { items: { step: { sourceId: string } }[] }).items)[0]?.step.sourceId, 'demo-cleanser-guide');
    const other = await fetch(base + '/api/auth/customer/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const otherCookie = other.headers.get('set-cookie')!.split(';')[0]!;
    const otherCsrf = (await other.json() as { csrfToken: string }).csrfToken;
    assert.equal((await fetch(base + `/api/customer/routines/${routineId}`, { headers: { Cookie: otherCookie } })).status, 404);
    assert.equal((await fetch(base + `/api/customer/care-events/${events.items[0]!.eventId}`, {
      method: 'DELETE', headers: { Cookie: otherCookie, 'X-CSRF-Token': otherCsrf },
    })).status, 404);
    const capabilities = await (await customer('/api/customer/input/capabilities')).json() as { asr: string; imageRecognition: string };
    assert.equal(capabilities.asr, 'not_configured'); assert.equal(capabilities.imageRecognition, 'not_configured');
    const revoked = await fetch(base + `/api/ops/device-credentials/${userId}`, { method: 'DELETE', headers: ops });
    assert.equal(revoked.status, 200);
    assert.equal((await deviceAction({ requestId: 'device-2', expectedStep: 1, action: 'stop' })).status, 401);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});
