import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/storage/store.js';
import { createApp } from '../server/app.js';
import { AppError } from '../server/core/errors.js';
import { productSchema, commentBatchSchema, insightSchema, evaluationCaseSchema } from '../server/contracts/index.js';
import { businessSkillSchema } from '../server/core/workflow-types.js';
import { testAccess, loginOperator } from './access-helper.js';

const load = async (name: string) => JSON.parse(await readFile(resolve('content/templates', name), 'utf8'));
const isCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-foundation-'));
  const store = new Store(join(dir, 'test.sqlite'));
  const server = createApp(store, undefined, { access: testAccess(store) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolveReady, reject) => {
    server.once('listening', resolveReady);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done());
      server.closeIdleConnections();
    });
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = await loginOperator(base);
  async function request(path: string, method = 'GET', input?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: { ...headers, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() as any, traceId: response.headers.get('x-trace-id') };
  }
  return { store, base, request };
}

test('business templates validate and insight counts refer to supplied comments', async () => {
  const product = productSchema.parse(await load('product.demo.json'));
  const batch = commentBatchSchema.parse(await load('comments.demo.json'));
  const insights = insightSchema.parse(await load('insights.demo.json'));
  businessSkillSchema.parse(await load('skill.template.json'));
  evaluationCaseSchema.array().parse(await load('cases.demo.json'));
  assert.equal(product.productId, batch.productId);
  assert.equal(insights.sampleSize, batch.comments.length);
  for (const entry of insights.tagCounts) {
    assert.deepEqual(entry.evidenceCommentIds, batch.comments.filter(c => c.tags.includes(entry.tag)).map(c => c.commentId));
  }
});

test('product import is versioned; only approved facts with sources reach knowledge API', async t => {
  const { request } = await fixture(t);
  const product = await load('product.demo.json');
  assert.equal((await request('/api/imports/products', 'POST', product)).status, 200);
  assert.equal((await request('/api/imports/products', 'POST', product)).body.status, 'unchanged');
  const knowledge = await request('/api/products/demo-product/knowledge');
  assert.equal(knowledge.body.facts.length, 1);
  assert.equal(knowledge.body.facts[0].sourceId, knowledge.body.sources[0].sourceId);
  const modified = structuredClone(product);
  modified.facts[0].text = 'Changed content';
  assert.equal((await request('/api/imports/products', 'POST', modified)).status, 409);
  modified.version = 'demo-v2';
  assert.equal((await request('/api/imports/products', 'POST', modified)).status, 200);
  await request('/api/imports/products', 'POST', product);
  assert.equal((await request('/api/products/demo-product/knowledge')).body.version, 'demo-v2');
  assert.equal((await request('/api/imports/products', 'POST', { ...product, productId: 'second-product' })).body.error.code, 'SINGLE_PRODUCT_SCOPE');
});

test('unapproved-only knowledge explicitly reports insufficient evidence', async t => {
  const { store } = await fixture(t);
  const product = await load('product.demo.json');
  product.facts.forEach((fact: { reviewStatus: string }) => { fact.reviewStatus = 'draft'; });
  store.importProduct(product);
  const result = store.getKnowledge('demo-product');
  assert.equal(result.status, 'insufficient_evidence');
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.sources, []);
});

test('comment import deduplicates and returns provenance without inventing unknown dates', async t => {
  const { store, request } = await fixture(t);
  store.importProduct(await load('product.demo.json'));
  const batch = await load('comments.demo.json');
  const first = await request('/api/imports/comments', 'POST', batch);
  assert.deepEqual(first.body, { batchId: batch.batchId, imported: 3, skipped: 0, total: 3 });
  assert.equal((await request('/api/imports/comments', 'POST', batch)).body.imported, 0);
  assert.equal((await request('/api/imports/comments', 'POST', { ...batch, batchId: 'another-batch' })).body.skipped, 3);
  const comments = (await request('/api/products/demo-product/comments?limit=10&offset=0')).body;
  assert.equal(comments.total, 3);
  assert.equal(comments.items[2].publishedAt, null);
  assert.equal(comments.items[0].source.sourceId, batch.sources[0].sourceId);
  assert.equal(comments.items[0].dataKind, 'demo');
});

test('conflicting comment rolls back earlier rows and batch, allowing corrected retry', async t => {
  const { store } = await fixture(t);
  store.importProduct(await load('product.demo.json'));
  const batch = await load('comments.demo.json');
  store.importComments(batch);
  const update = structuredClone(batch);
  update.batchId = 'conflicting-batch';
  update.comments = [
    { ...batch.comments[0], commentId: 'new-comment' },
    { ...batch.comments[1], text: 'Conflicting revision' },
  ];
  assert.throws(() => store.importComments(update), isCode('COMMENT_CONFLICT'));
  assert.equal(store.listComments('demo-product', 50, 0).total, 3);
  update.comments[1] = batch.comments[1];
  assert.equal(store.importComments(update).imported, 1);
  assert.equal(store.listComments('demo-product', 50, 0).total, 4);
});

test('rejects broken sources, duplicate IDs, extra identifying fields and invalid dates before writes', async t => {
  const { store, request } = await fixture(t);
  store.importProduct(await load('product.demo.json'));
  const batch = await load('comments.demo.json');
  const brokenSource = structuredClone(batch);
  brokenSource.comments[0].sourceRef = 'missing-source';
  const response = await request('/api/imports/comments', 'POST', brokenSource);
  assert.equal(response.status, 422);
  assert.ok(response.body.error.issues.some((issue: { path: string }) => issue.path === 'comments.0.sourceRef'));
  assert.equal(response.body.error.traceId, response.traceId);
  for (const patch of [
    { publishedAt: '2026-02-30' },
    { publishedAt: '2020-01-01' },
    { nickname: 'not allowed' },
  ]) {
    const invalid = structuredClone(batch);
    Object.assign(invalid.comments[0], patch);
    assert.equal((await request('/api/imports/comments', 'POST', invalid)).status, 422);
  }
  const duplicates = structuredClone(batch);
  duplicates.comments.push(duplicates.comments[0]);
  assert.equal((await request('/api/imports/comments', 'POST', duplicates)).status, 422);
  assert.equal(store.listComments('demo-product', 50, 0).total, 0);
});

test('same-user sessions share confirmed card, while user B cannot read or write A session', async t => {
  const { store, request } = await fixture(t);
  store.importProduct(await load('product.demo.json'));
  store.createUser({ userId: 'user-a', displayName: 'A' });
  store.createUser({ userId: 'user-b', displayName: 'B' });
  const first = store.createSession('user-a', 'demo-product');
  const second = store.createSession('user-a', 'demo-product');
  const message = store.appendUserMessage('user-a', first.sessionId, { requestId: 'request-a', content: '我偏好清爽' });
  store.updateCard('user-a', {
    expectedVersion: 0,
    confirmedFacts: { texturePreference: { value: '清爽', sourceMessageId: message.message.messageId } },
    preferences: ['清爽'],
  });
  const context = await request(`/api/users/user-a/sessions/${second.sessionId}/context`);
  assert.deepEqual(context.body.card.preferences, ['清爽']);
  assert.deepEqual(context.body.recentMessages, []);
  assert.deepEqual(store.getCard('user-b').preferences, []);
  const wrongPath = `/api/users/user-b/sessions/${first.sessionId}`;
  assert.equal((await request(`${wrongPath}/context`)).status, 404);
  assert.equal((await request(`${wrongPath}/messages`)).status, 404);
  assert.equal((await request(`${wrongPath}/messages`, 'POST', { requestId: 'bad-write', content: 'bad' })).status, 404);
  assert.throws(() => store.updateCard('user-b', {
    expectedVersion: 0,
    confirmedFacts: { copied: { value: 'invalid', sourceMessageId: message.message.messageId } },
  }), isCode('INVALID_FACT_SOURCE'));
});

test('card optimistic version prevents lost updates; explicit empty fields clear data', async t => {
  const { store, request } = await fixture(t);
  store.createUser({ userId: 'user-a', displayName: 'A' });
  const path = '/api/users/user-a/card';
  assert.equal((await request(path, 'PATCH', { expectedVersion: 0, preferences: ['清爽'] })).body.version, 1);
  assert.equal((await request(path, 'PATCH', { expectedVersion: 0, preferences: ['覆盖'] })).status, 409);
  assert.deepEqual((await request(path)).body.preferences, ['清爽']);
  assert.equal((await request(path, 'PATCH', { expectedVersion: 1 })).status, 422);
  assert.deepEqual((await request(path, 'PATCH', { expectedVersion: 1, preferences: [] })).body.preferences, []);
});

test('message writes are idempotent and cannot impersonate AI', async t => {
  const { store, request } = await fixture(t);
  store.importProduct(await load('product.demo.json'));
  store.createUser({ userId: 'user-a', displayName: 'A' });
  const session = store.createSession('user-a', 'demo-product');
  const path = `/api/users/user-a/sessions/${session.sessionId}/messages`;
  const input = { requestId: 'request-1', content: '你好' };
  const first = await request(path, 'POST', input);
  const duplicate = await request(path, 'POST', input);
  assert.equal(first.status, 201);
  assert.equal(first.body.processing, 'not_implemented');
  assert.equal(duplicate.status, 200);
  assert.equal(first.body.message.messageId, duplicate.body.message.messageId);
  assert.equal((await request(path, 'POST', { ...input, content: 'Different' })).status, 409);
  assert.equal((await request(path, 'POST', { ...input, requestId: 'fake-ai', role: 'assistant' })).status, 422);
  assert.equal((await request(path)).body.total, 1);
});

test('SQLite persistence survives closing/reopening, and duplicate imports stay idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-restart-'));
  const path = join(dir, 'test.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(path);
    const product = await load('product.demo.json');
    const batch = await load('comments.demo.json');
    store.importProduct(product);
    store.importComments(batch);
    store.createUser({ userId: 'persisted-user', displayName: 'Persisted' });
    store.updateCard('persisted-user', { expectedVersion: 0, concerns: ['使用后紧绷'] });
    const session = store.createSession('persisted-user', 'demo-product');
    store.appendUserMessage('persisted-user', session.sessionId, { requestId: 'saved', content: '保存的消息' });
    store.close();
    store = undefined;
    store = new Store(path);
    const context = store.getContext('persisted-user', session.sessionId);
    assert.deepEqual(context.card.concerns, ['使用后紧绷']);
    assert.equal(context.recentMessages[0]?.content, '保存的消息');
    assert.equal(store.importComments(batch).imported, 0);
    assert.equal(store.listComments('demo-product', 50, 0).total, 3);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('API returns health, bounded pagination and structured malformed JSON errors', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/health')).body.database, true);
  const home = await fetch(base + '/');
  assert.ok(home.url.endsWith('/chat/'));
  assert.match(await home.text(), /专属美妆顾问/);
  assert.equal((await request('/api/products/demo-product/comments?limit=0')).status, 422);
  assert.equal((await request('/not-a-route')).status, 404);
  const malformed = await fetch(`${base}/api/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as any).error.code, 'INVALID_JSON');
  const origin = await fetch(`${base}/health`, { headers: { Origin: 'https://unrelated.example' } });
  assert.equal(origin.status, 403);
});
