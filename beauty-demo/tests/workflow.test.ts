import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/storage/store.js';
import { Workflows } from '../server/storage/workflows.js';
import { CustomerService } from '../server/core/customer-service.js';
import { loadBusinessConfig, baseRoute, ruleRoute } from '../server/core/registry.js';
import { JevProvider, ChatProvider, ProviderError } from '../server/core/providers.js';
import { businessConfigSchema, type DecisionProvider, type GenerationProvider, type RouteRecord } from '../server/core/workflow-types.js';
import { createApp } from '../server/app.js';
import { AppError } from '../server/core/errors.js';
import { testAccess, loginOperator } from './access-helper.js';

const config = loadBusinessConfig();
const load = async (name: string) => JSON.parse(await readFile(resolve('content/templates', name), 'utf8'));
const normalRoute = (): RouteRecord => ({ ...baseRoute(config, 'TEST_ONLY'), routeStatus: 'jev', intent: 'product_advice', emotion: 'neutral', riskLevel: 'low', primarySkill: 'product_consult', action: 'answer', model: 'test-jev' });
const fakeRouter: DecisionProvider = { configured: true, decide: async () => normalRoute() };
const fakeGenerator: GenerationProvider = { configured: true, generate: async () => ({ answer: '测试替身回答，不是API结果。', sourceRefs: ['demo-manual'], model: 'test-chat', usage: { input_tokens: 1 } }) };

async function fixture(t: TestContext, router = fakeRouter, generator = fakeGenerator) {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-workflow-'));
  const store = new Store(join(dir, 'test.sqlite'));
  store.importProduct(await load('product.demo.json'));
  store.importComments(await load('comments.demo.json'));
  store.createUser({ userId: 'user-a', displayName: 'A' });
  store.createUser({ userId: 'user-b', displayName: 'B' });
  const session = store.createSession('user-a', 'demo-product');
  const service = new CustomerService(store, { config, router, generator });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, service, sessionId: session.sessionId, dir };
}

test('business registry validates all skills and intent references; demo rules preserve explicit negation', () => {
  assert.equal(config.skills.length, 3);
  assert.equal(Object.keys(config.intents).length, 4);
  const bad = structuredClone(config); bad.skills[1]!.id = bad.skills[0]!.id;
  assert.equal(businessConfigSchema.safeParse(bad).success, false);
  const unknown = structuredClone(config); unknown.skills[0]!.intents = ['unknown'];
  assert.equal(businessConfigSchema.safeParse(unknown).success, false);
  assert.equal(ruleRoute('没有呼吸困难，也不要转人工', config), null);
  assert.equal(ruleRoute('没有呼吸困难，但是脸肿了', config)?.route.riskLevel, 'high');
});

test('Jev adapter batches fixed questions and handles high-risk even with low classification confidence', async () => {
  const answer = (value: string, confidence = 0.9) => ({ type: 'choice', choice: value, confidence, probabilities: { [value]: 1 } });
  const response = { model: 'jev-test', usage: { input_tokens: 12 }, answers: {
    intent: answer('product_advice'), emotion: answer('anxious'), risk: answer('high', 0.2),
    primary_skill: answer('product_consult'), needs_human: { type: 'noul', noul: 0.1 }, information_sufficient: { type: 'noul', noul: 0.8 },
  } };
  let calls = 0;
  const provider = new JevProvider('test-key', async (url, init) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.model, 'jev-latest');
    assert.equal(sent.state.userText, '原文');
    assert.equal(Object.keys(sent.questions).length, 6);
    assert.match(sent.questions.information_sufficient.instructions, /Product knowledge is retrieved after routing/);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    return Response.json(response);
  });
  const input = { userText: '原文', recentMessages: [], card: { userId: 'u', confirmedFacts: {}, preferences: [], concerns: [], version: 0, updatedAt: '' } };
  const route = await provider.decide(input, config, new AbortController().signal);
  assert.equal(route.action, 'handoff'); assert.equal(route.primarySkill, null); assert.equal(route.model, 'jev-test');
  response.answers.risk = answer('low'); response.answers.primary_skill = answer('other');
  assert.equal((await provider.decide(input, config, new AbortController().signal)).action, 'clarify');
  response.answers.primary_skill = answer('injected-skill');
  await assert.rejects(provider.decide(input, config, new AbortController().signal), /JEV_UNKNOWN_OPTION/);
  assert.equal(calls, 3);
});

test('generation adapter rejects invented or absent citations and truncated results', async t => {
  const { store } = await fixture(t);
  const input = { userText: '咨询', card: store.getCard('user-a'), recentMessages: [], skill: config.skills[0]!, knowledge: store.getKnowledge('demo-product'), comments: [] };
  const settings = { apiKey: 'test-key', baseUrl: 'https://example.test/v1', model: 'test-model' };
  for (const refs of [[], ['invented-source']]) {
    const provider = new ChatProvider(settings, async () => Response.json({ model: 'test-model', choices: [{ message: { content: JSON.stringify({ answer: '答复', sourceRefs: refs }) }, finish_reason: 'stop' }] }));
    await assert.rejects(provider.generate(input, new AbortController().signal), /CHAT_(MISSING|INVALID)_CITATION/);
  }
  const truncated = new ChatProvider(settings, async () => Response.json({ model: 'test-model', choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }));
  await assert.rejects(truncated.generate(input, new AbortController().signal), /CHAT_TRUNCATED/);
});

test('consult executes once, persists route/source metadata, and replays identical request without provider calls', async t => {
  let calls = 0;
  const router: DecisionProvider = { configured: true, decide: async () => { calls++; return normalRoute(); } };
  const { service, store, sessionId } = await fixture(t, router);
  const input = { requestId: 'one', content: '介绍一下产品' };
  const first = await service.consult('user-a', sessionId, input);
  assert.equal(first.status, 'answered'); assert.equal(first.answerKind, 'generated');
  assert.equal(first.generation?.skillId, 'product_consult');
  const replay = await service.consult('user-a', sessionId, input);
  assert.deepEqual(replay, first); assert.equal(calls, 1);
  assert.equal(store.listMessages('user-a', sessionId, 100, 0).total, 2);
  assert.deepEqual(store.listMessages('user-a', sessionId, 100, 0).items[1]!.metadata.sourceRefs, ['demo-manual']);
  await assert.rejects(service.consult('user-a', sessionId, { ...input, content: 'Different' }), error => error instanceof AppError && error.code === 'REQUEST_CONFLICT');
});

test('missing credentials produce explicit persisted degraded result, never a fake Jev answer', async t => {
  const { service, sessionId } = await fixture(t, new JevProvider(''), new ChatProvider({ apiKey: '', baseUrl: 'https://example.test', model: '' }));
  const result = await service.consult('user-a', sessionId, { requestId: 'offline', content: '说明一下产品' });
  assert.equal(result.status, 'degraded'); assert.equal(result.answerKind, 'template');
  assert.equal(result.route?.model, null); assert.equal(result.route?.routeStatus, 'degraded');
  assert.ok(result.warnings.includes('PROVIDER_NOT_CONFIGURED'));
});

test('explicit risk bypasses model calls; human state stops AI and supports claim/reply/resolve', async t => {
  const never: DecisionProvider = { configured: true, decide: async () => { throw new Error('must not call router'); } };
  const { service, store, sessionId } = await fixture(t, never);
  const risk = await service.consult('user-a', sessionId, { requestId: 'risk', content: '今天用了以后脸肿了，想退货' });
  assert.equal(risk.status, 'handoff_pending'); assert.equal(risk.route?.riskLevel, 'high');
  assert.ok(risk.handoffId); assert.equal(store.getSession('user-a', sessionId).status, 'HANDOFF_PENDING');
  const ticket = service.workflows.getHandoff(risk.handoffId!);
  assert.ok(ticket.summary.reportedFacts[0].messageId);
  assert.match(ticket.summary.request, /想退货/);
  assert.throws(() => service.workflows.humanReply(ticket.id, { requestId: 'reply', content: '人工回复' }), /Claim/);
  assert.equal(service.workflows.claim(ticket.id).status, 'active');
  const more = await service.consult('user-a', sessionId, { requestId: 'follow-up', content: '接下来怎么处理？' });
  assert.equal(more.status, 'human_active');
  const reply = service.workflows.humanReply(ticket.id, { requestId: 'reply', content: '我是演示坐席，请补充使用时间。' });
  assert.equal(service.workflows.humanReply(ticket.id, { requestId: 'reply', content: '我是演示坐席，请补充使用时间。' }).duplicate, true);
  assert.ok(reply.messageId);
  assert.equal(service.workflows.resolve(ticket.id).status, 'resolved');
  assert.equal(store.getSession('user-a', sessionId).status, 'RESOLVED');
  assert.equal((await service.consult('user-a', sessionId, { requestId: 'closed', content: '再咨询' })).status, 'resolved');
});

test('handoff while generation is pending aborts and suppresses late AI response', async t => {
  let release!: (value: Awaited<ReturnType<GenerationProvider['generate']>>) => void;
  let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const slow: GenerationProvider = { configured: true, generate: async () => {
    entered(); return new Promise(resolveAnswer => { release = resolveAnswer; });
  } };
  const { service, store, sessionId } = await fixture(t, fakeRouter, slow);
  const pending = service.consult('user-a', sessionId, { requestId: 'slow', content: '产品介绍' });
  await ready;
  await assert.rejects(service.consult('user-a', sessionId, { requestId: 'overlap', content: '普通第二条' }), /Another consultation/);
  const handoff = service.requestHandoff('user-a', sessionId, '用户要求人工');
  release({ answer: '不应出现的晚到推荐', sourceRefs: ['demo-manual'], model: 'test', usage: {} });
  const result = await pending;
  assert.equal(result.status, 'interrupted'); assert.equal(result.answer, null);
  assert.ok(!store.listMessages('user-a', sessionId, 100, 0).items.some(m => m.content.includes('晚到推荐')));
  assert.equal(service.requestHandoff('user-a', sessionId, '再次请求').id, handoff.id);
});

test('explicit high-risk second message preempts in-flight routing without waiting', async t => {
  let release!: (value: RouteRecord) => void;
  let ready!: () => void;
  const started = new Promise<void>(r => { ready = r; });
  const slow: DecisionProvider = { configured: true, decide: async () => { ready(); return new Promise(r => { release = r; }); } };
  const { service, sessionId } = await fixture(t, slow);
  const first = service.consult('user-a', sessionId, { requestId: 'pending', content: '产品咨询' });
  await started;
  const urgent = await service.consult('user-a', sessionId, { requestId: 'urgent', content: '现在呼吸困难' });
  assert.equal(urgent.status, 'handoff_pending');
  release(normalRoute());
  assert.equal((await first).status, 'interrupted');
});

test('caller cancellation saves queryable cancelled result without a generated message', async t => {
  let release!: (value: RouteRecord) => void;
  const router: DecisionProvider = { configured: true, decide: async () => new Promise(r => { release = r; }) };
  const { service, sessionId } = await fixture(t, router);
  const abort = new AbortController();
  const pending = service.consult('user-a', sessionId, { requestId: 'cancel', content: '产品咨询' }, abort.signal);
  abort.abort(); release(normalRoute());
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(result.answer, null);
  assert.equal(service.workflows.result('user-a', sessionId, 'cancel').result?.status, 'cancelled');
});

test('feedback is replaceable, triggers handoff and preserves traceable separate dashboard denominators', async t => {
  const { service, sessionId } = await fixture(t);
  const answer = await service.consult('user-a', sessionId, { requestId: 'answer', content: '介绍产品' });
  service.feedback('user-a', answer.messageId!, { type: 'helpful' });
  service.feedback('user-a', answer.messageId!, { type: 'helpful' });
  assert.equal(service.workflows.dashboard().service.helpfulRate, 1);
  service.feedback('user-a', answer.messageId!, { type: 'unresolved', reason: '不够贴合' });
  let dashboard = service.workflows.dashboard();
  assert.equal(dashboard.service.helpful, 0); assert.equal(dashboard.service.unresolved, 1);
  assert.equal(dashboard.service.feedback.length, 1);
  assert.equal(dashboard.comments.sampleSize, 3);
  assert.equal(dashboard.comments.unknownDateCount, 1);
  assert.deepEqual(dashboard.comments.cooccurrence[0]?.commentIds, ['demo-comment-001']);
  assert.throws(() => service.feedback('user-b', answer.messageId!, { type: 'helpful' }), /not found/);
  const result = service.feedback('user-a', answer.messageId!, { type: 'request_human' });
  assert.equal(result.nextAction, 'handoff');
  dashboard = service.workflows.dashboard();
  assert.equal(dashboard.service.pendingHandoffs, 1);
  assert.equal(dashboard.service.helpfulRate, null);
});

test('v1 database upgrades without losing cards/messages, and interrupted jobs recover without replaying models', async t => {
  const { store, dir, sessionId } = await fixture(t);
  store.updateCard('user-a', { expectedVersion: 0, preferences: ['清爽'] });
  store.appendUserMessage('user-a', sessionId, { requestId: 'saved', content: '旧版消息' });
  store.db.exec(`DROP TABLE run_events; DROP TABLE run_snapshots; DROP TABLE feedback; DROP TABLE handoffs; DROP TABLE consultation_runs; ALTER TABLE messages DROP COLUMN metadata; PRAGMA user_version=1;`);
  // A second handle simulates the upgrade while the old handle is idle.
  const upgraded = new Store(join(dir, 'test.sqlite'));
  try {
    assert.equal(upgraded.health().schemaVersion, 4);
    assert.deepEqual(upgraded.getCard('user-a').preferences, ['清爽']);
    assert.equal(upgraded.listMessages('user-a', sessionId, 20, 0).items[0]?.content, '旧版消息');
    const work = new Workflows(upgraded);
    work.begin('user-a', sessionId, { requestId: 'crashed', content: '进程中断前消息' });
    assert.equal(work.recoverInterrupted(), 1);
    assert.equal(work.result('user-a', sessionId, 'crashed').result?.warnings[0], 'SERVER_RESTARTED');
  } finally { upgraded.close(); }
});

test('HTTP consult, operator actions and dashboard use real app contracts', async t => {
  const { service, store, sessionId } = await fixture(t);
  const server = createApp(store, service, { access: testAccess(store) }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = await loginOperator(base);
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const response = await post(`/api/users/user-a/sessions/${sessionId}/consult`, { requestId: 'api', content: '转人工' });
    assert.equal(response.status, 200);
    const result = await response.json() as { handoffId: string };
    assert.equal((await post(`/api/handoffs/${result.handoffId}/claim`, {})).status, 200);
    assert.equal((await post(`/api/handoffs/${result.handoffId}/reply`, { requestId: 'reply', content: '人工消息' })).status, 200);
    assert.equal((await fetch(base + '/api/dashboard', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/status', { headers })).status, 200);
  } finally {
    await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
  }
});
