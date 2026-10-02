import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { strToU8, zipSync } from 'fflate';
import { Store } from '../server/storage/store.js';
import { loadBusinessConfig, baseRoute } from '../server/core/registry.js';
import { SkillPackages, parseSkillUpload } from '../server/core/skill-packages.js';
import { ModelSettings } from '../server/core/model-settings.js';
import { CustomerService } from '../server/core/customer-service.js';
import { createApp } from '../server/app.js';
import type { BusinessConfig, DecisionProvider, GenerationProvider, RouteRecord } from '../server/core/workflow-types.js';
import { testAccess, loginOperator } from './access-helper.js';

const config = loadBusinessConfig();
const md = '---\nname: evening-guide\ndescription: 晚间演示套装顺序咨询\nversion: v1\nrequiresKnowledge: false\n---\n# 晚间助手\n根据用户需求说明演示步骤，不能编造产品功效。';
const normal = (config: BusinessConfig, skill = 'product_consult'): RouteRecord => ({
  ...baseRoute(config, 'TEST_ONLY'), routeStatus: 'jev', intent: 'product_advice', emotion: 'neutral', riskLevel: 'low', primarySkill: skill, action: 'answer', model: 'test-router',
});
const defaultRouter: DecisionProvider = { configured: true, decide: async (_input, cfg) => normal(cfg) };
const defaultGenerator: GenerationProvider = { configured: true, generate: async input => ({ answer: input.responseMode === 'clarify' ? '请说明您想确认的具体售后问题。' : '测试回答', sourceRefs: [], model: 'test-generator', usage: {} }) };
async function fixture(t: TestContext, router = defaultRouter, generator = defaultGenerator) {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-authoring-'));
  const database = join(dir, 'test.sqlite'); const store = new Store(database);
  store.importProduct(JSON.parse(await readFile(resolve('content/templates/product.demo.json'), 'utf8')));
  store.createUser({ userId: 'author', displayName: 'Author' });
  const session = store.createSession('author', 'demo-product');
  const settings = new ModelSettings(join(dir, 'model-settings.json'), {});
  const service = new CustomerService(store, { config, router, generator, modelSettings: settings });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, database, store, sessionId: session.sessionId, service, settings };
}

test('standard SKILL.md imports with defaults and explicit author overrides', () => {
  const parsed = parseSkillUpload({ filename: 'SKILL.md', content: md });
  assert.equal(parsed.id, 'evening-guide'); assert.equal(parsed.requiresKnowledge, false);
  assert.equal(parseSkillUpload({ filename: 'SKILL.md', content: md, overrides: { version: '1.0.0' } }).version, '1.0.0');
  assert.deepEqual(parsed.intents, ['product_advice']); assert.match(parsed.instructions, /晚间助手/);
  const plain = parseSkillUpload({ filename: 'my.md', content: '# 任意Markdown正文', overrides: { id: 'plain-guide', description: '纯Markdown导入' } });
  assert.equal(plain.id, 'plain-guide'); assert.ok(plain.version.startsWith('import-'));
  assert.throws(() => parseSkillUpload({ filename: 'SKILL.md', content: '# 缺少ID' }), /请填写Skill ID/);
});

test('ZIP imports embedded knowledge; traversal, executable files and decompression bombs are rejected', () => {
  const make = (files: Record<string, Uint8Array>) => ({ filename: 'skill.zip', encoding: 'base64', content: Buffer.from(zipSync(files)).toString('base64') });
  const bundle = parseSkillUpload(make({ 'my-skill/SKILL.md': strToU8(md), 'my-skill/knowledge/reference.md': strToU8('演示暗号：紫色星河。') }));
  assert.equal(bundle.knowledge[0]?.content, '演示暗号：紫色星河。');
  for (const extra of ['../escape.md', 'scripts/run.js', 'C:/escape.md']) {
    assert.throws(() => parseSkillUpload(make({ 'SKILL.md': strToU8(md), [extra]: strToU8('payload') })), /ZIP损坏/);
  }
  assert.throws(() => parseSkillUpload(make({ 'SKILL.md': strToU8(md), 'knowledge/huge.md': strToU8('x'.repeat(600_000)) })), /ZIP损坏/);
  const template = parseSkillUpload({ filename: 'template.zip', encoding: 'base64', content: Buffer.from(SkillPackages.template()).toString('base64') });
  assert.equal(template.requiresKnowledge, true); assert.equal(template.knowledge.length, 1);
});

test('uploaded skill is persisted, enabled immediately, version checked, and removable from routing by disabling', async t => {
  const { service, database } = await fixture(t);
  const before = service.config.version;
  service.skills.import({ filename: 'SKILL.md', content: md });
  assert.equal(service.config.skills.length, 4); assert.notEqual(service.config.version, before);
  assert.throws(() => service.skills.import({ filename: 'SKILL.md', content: md + '\n新内容但未改版本' }), /修改version/);
  const other = new Store(database);
  try {
    const restored = new SkillPackages(other, config);
    assert.equal(restored.config().skills.find(s => s.id === 'evening-guide')?.version, 'v1');
    restored.enable('evening-guide', false);
    assert.ok(!service.config.skills.some(s => s.id === 'evening-guide'));
    assert.equal(restored.list().find(s => s.skill.id === 'evening-guide')?.enabled, false);
  } finally { other.close(); }
});

test('uploaded instructions and knowledge reach the executor with source IDs; config is snapshotted for running requests', async t => {
  let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
  let continueRoute!: () => void;
  const router: DecisionProvider = { configured: true, decide: async (_input, cfg) => {
    enter(); await new Promise<void>(r => { continueRoute = r; }); return normal(cfg, 'evening-guide');
  } };
  let seenVersion = '';
  const generator: GenerationProvider = { configured: true, generate: async input => {
    seenVersion = input.skill.version;
    assert.match(input.skill.instructions, /晚间助手/);
    const fact = input.knowledge.facts.find(f => f.text.includes('紫色星河'));
    assert.ok(fact); assert.ok(fact.sourceId.startsWith('skill-'));
    assert.ok(input.knowledge.sources.some(s => s.sourceId === fact.sourceId));
    return { answer: '紫色星河', sourceRefs: [fact.sourceId], model: 'test-generator', usage: {} };
  } };
  const { service, sessionId } = await fixture(t, router, generator);
  const skill = parseSkillUpload({ filename: 'SKILL.md', content: md }); skill.requiresKnowledge = true;
  skill.knowledge = [{ title: '演示知识', content: '演示暗号：紫色星河。' }];
  service.skills.import({ filename: 'guide.json', content: JSON.stringify(skill) });
  const pending = service.consult('author', sessionId, { requestId: 'uploaded', content: '请说明晚间助手知识' });
  await entered;
  service.skills.import({ filename: 'guide.json', content: JSON.stringify({ ...skill, version: 'v2', instructions: '更新后的说明' }) });
  continueRoute();
  const result = await pending;
  assert.equal(result.status, 'answered'); assert.equal(seenVersion, 'v1'); assert.equal(result.generation?.skillId, 'evening-guide');
  assert.equal(service.config.skills.find(s => s.id === 'evening-guide')?.version, 'v2');
});

test('greeting/uncertain intent produces contextual conversation, and after-sales without facts produces model clarification', async t => {
  let selectedMode = '';
  const router: DecisionProvider = { configured: true, decide: async (input, cfg) => input.userText === '你好'
    ? { ...normal(cfg), intent: null, primarySkill: null, action: 'clarify', reasonCodes: ['NO_BUSINESS_INTENT'] }
    : { ...normal(cfg, 'after_sales'), intent: 'after_sales' } };
  const generator: GenerationProvider = { configured: true, generate: async input => {
    selectedMode = input.responseMode!;
    return { answer: input.responseMode === 'conversation' ? '你好，你想了解产品还是售后？' : '你想咨询退货条件，还是具体包裹的问题？', sourceRefs: [], model: 'test-generator', usage: {} };
  } };
  const { service, sessionId } = await fixture(t, router, generator);
  const greeting = await service.consult('author', sessionId, { requestId: 'hello', content: '你好' });
  assert.equal(greeting.status, 'answered'); assert.equal(greeting.answerKind, 'generated'); assert.equal(selectedMode, 'conversation');
  const sales = await service.consult('author', sessionId, { requestId: 'sales', content: '我想了解售后' });
  assert.equal(sales.status, 'clarification_required'); assert.equal(sales.answerKind, 'generated'); assert.equal(selectedMode, 'clarify');
  assert.match(sales.answer!, /包裹/); assert.notEqual(sales.answer, config.templates.noKnowledge);
});

test('emotional support does not require product facts and real product data is not globally blocked by demo policy flag', async t => {
  const router: DecisionProvider = { configured: true, decide: async (_input, cfg) => ({ ...normal(cfg, 'emotional_support'), intent: 'emotional_support' }) };
  let generated = 0;
  const generator: GenerationProvider = { configured: true, generate: async input => {
    generated++; assert.equal(input.skill.requiresKnowledge, false);
    return { answer: '听起来你有些挫败，我愿意听你说。', sourceRefs: [], model: 'test', usage: {} };
  } };
  const { service, store, sessionId } = await fixture(t, router, generator);
  const product = store.getProduct('demo-product');
  product.dataKind = 'business'; product.facts.forEach(f => { f.reviewStatus = 'draft'; });
  // Test fixture changes metadata directly; no production review bypass endpoint is exposed.
  store.db.prepare('UPDATE product_versions SET document=?').run(JSON.stringify(product));
  const result = await service.consult('author', sessionId, { requestId: 'emotion', content: '最近很烦躁，想说说话' });
  assert.equal(result.status, 'answered'); assert.equal(generated, 1); assert.equal(result.sourceRefs.length, 0);
});

test('model settings persist locally, reload on restart, and API responses never contain saved secrets', async t => {
  const { dir, settings } = await fixture(t);
  const keys = { typesafeApiKey: 'fake-typesafe-key-for-tests', chatApiKey: 'fake-chat-key-for-tests' };
  const publicView = settings.update({ ...keys, chatModel: 'deepseek-flash', chatBaseUrl: 'https://api.deepseek.com/v1' });
  assert.ok(!JSON.stringify(publicView).includes(keys.typesafeApiKey));
  const restored = new ModelSettings(join(dir, 'model-settings.json'), {});
  assert.equal(restored.current().typesafeApiKey, keys.typesafeApiKey);
  restored.update({ chatModel: 'another-model' });
  assert.equal(restored.current().chatApiKey, keys.chatApiKey);
  assert.throws(() => restored.update({ chatBaseUrl: 'https://user:secret@api.example' }));
});

test('authoring HTTP endpoints upload a ZIP, toggle a skill and save redacted connection settings', async t => {
  const { service, store } = await fixture(t);
  const server = createApp(store, service, { access: testAccess(store) }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = await loginOperator(base);
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    const zip = await fetch(base + '/api/skills/template.zip', { headers }); assert.equal(zip.status, 200);
    const imported = await request('/api/skills/import', 'POST', { filename: 'template.zip', encoding: 'base64', content: Buffer.from(await zip.arrayBuffer()).toString('base64') });
    assert.equal(imported.status, 200); assert.equal(imported.data.skill.id, 'beauty-usage-guide');
    assert.equal((await request('/api/skills/beauty-usage-guide', 'PATCH', { enabled: false })).status, 200);
    const saved = await request('/api/settings/models', 'PUT', { typesafeApiKey: 'fake-typesafe-key-for-tests', chatApiKey: 'fake-chat-key-for-tests', chatModel: 'deepseek-flash' });
    assert.equal(saved.status, 200); assert.ok(!JSON.stringify(saved.data).includes('fake-'));
    assert.equal((await request('/api/status')).data.providers.chatConfigured, true);
  } finally { await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); }); }
});
