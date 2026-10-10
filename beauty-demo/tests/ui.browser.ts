import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright-core';
import { Store } from '../server/storage/store.js';
import { CustomerService } from '../server/core/customer-service.js';
import { loadBusinessConfig, baseRoute } from '../server/core/registry.js';
import { createApp } from '../server/app.js';
import { ModelSettings } from '../server/core/model-settings.js';
import { JevProvider, ChatProvider } from '../server/core/providers.js';
import { SkillPackages } from '../server/core/skill-packages.js';
import { testAccess, testOperatorPassword } from './access-helper.js';

const executablePath = process.env.BROWSER_PATH ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(path => existsSync(path));

async function operatorLogin(page: Page, base: string) {
  await page.goto(base + '/ops/');
  await page.locator('#operator-password').fill(testOperatorPassword);
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.getByRole('button', { name: '登录运营端', exact: true }).click()]);
  await page.locator('#operator-workspace').waitFor();
}

test('browser: card memory, real UI consult, feedback, human takeover and traceable dashboard', {
  timeout: 60_000, skip: !executablePath && 'Set BROWSER_PATH to a locally installed Chromium browser',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-ui-'));
  const store = new Store(join(dir, 'ui.sqlite'));
  const load = async (name: string) => JSON.parse(await readFile(resolve('content/templates', name), 'utf8'));
  store.importProduct(await load('product.demo.json')); store.importComments(await load('comments.demo.json'));
  store.createUser({ userId: 'ui-user', displayName: '浏览器测试用户' });
  const config = loadBusinessConfig();
  const service = new CustomerService(store, { config,
    router: { configured: true, decide: async () => ({ ...baseRoute(config, 'BROWSER_TEST_ONLY'), routeStatus: 'jev', intent: 'product_advice', emotion: 'neutral', riskLevel: 'low', primarySkill: 'product_consult', action: 'answer', model: 'browser-test' }) },
    generator: { configured: true, generate: async () => ({ answer: '这是一条浏览器测试替身回答，不是付费API结果。', sourceRefs: ['demo-manual'], model: 'browser-test', usage: {} }) },
  });
  const server = createApp(store, service, { access: testAccess(store) }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } });
    page.setDefaultTimeout(8_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await operatorLogin(page, base);
    await page.locator('#user-select option').first().waitFor({ state: 'attached' });
    const openedCard = page.waitForResponse(r => r.url().endsWith('/card') && r.request().method() === 'GET');
    await page.getByRole('button', { name: '用户资料卡', exact: true }).click();
    await openedCard;
    await page.locator('#preferences').fill('清爽\n简单步骤');
    const saved = page.waitForResponse(r => r.url().endsWith('/card') && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: '保存确认信息' }).click();
    const savedResponse = await saved;
    assert.equal(savedResponse.status(), 200);
    assert.deepEqual((await savedResponse.json()).preferences, ['清爽', '简单步骤']);
    await page.getByRole('button', { name: '客服测试', exact: true }).click();
    const newSession = page.waitForResponse(r => r.url().endsWith('/sessions') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const session = await (await newSession).json() as { sessionId: string };
    await page.locator('#session-select').selectOption(session.sessionId);
    await page.locator('#message-input').fill('介绍产品');
    const consultation = page.waitForResponse(r => r.url().endsWith('/consult'));
    await page.getByRole('button', { name: '发送咨询', exact: true }).click();
    assert.equal((await consultation).status(), 200);
    await page.getByText('这是一条浏览器测试替身回答，不是付费API结果。', { exact: true }).waitFor();
    const feedback = page.waitForResponse(r => r.url().endsWith('/feedback'));
    await page.getByRole('button', { name: '有帮助', exact: true }).click();
    assert.equal((await feedback).status(), 200);
    const handoff = page.waitForResponse(r => r.url().endsWith('/handoff'));
    await page.locator('#request-human').click();
    assert.equal((await handoff).status(), 200);
    await page.getByRole('button', { name: '人工接管', exact: true }).click();
    await page.getByRole('button', { name: '接管', exact: true }).click();
    await page.getByRole('textbox', { name: '人工回复' }).fill('本地坐席已收到，请补充时间。');
    const reply = page.waitForResponse(r => r.url().endsWith('/reply'));
    await page.getByRole('button', { name: '发送人工回复', exact: true }).click();
    assert.equal((await reply).status(), 200);
    await page.getByRole('button', { name: '客服测试', exact: true }).click();
    await page.getByText('本地坐席已收到，请补充时间。', { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: '风险看板', exact: true }).click();
    await page.locator('#tag-table').getByText('卡粉', { exact: true }).waitFor();
    assert.deepEqual(store.getCard('ui-user').preferences, ['清爽', '简单步骤']);
    assert.equal(service.workflows.dashboard().service.helpful, 1);
    assert.equal(service.workflows.dashboard().service.activeHandoffs, 1);
    assert.deepEqual(errors, []);
    await mkdir(resolve('test-results'), { recursive: true });
    await page.screenshot({ path: resolve('test-results/ui-demo.png'), fullPage: true });
  } finally {
    await browser.close();
    await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('browser: a fresh user sees actionable setup, can save credentials, and keys are not echoed', {
  timeout: 45_000, skip: !executablePath && 'Set BROWSER_PATH',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-setup-ui-'));
  const store = new Store(join(dir, 'ui.sqlite'));
  const service = new CustomerService(store, {
    modelSettings: new ModelSettings(join(dir, 'model-settings.json'), {}),
    router: new JevProvider(''), generator: new ChatProvider({ apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }),
  });
  const server = createApp(store, service, { access: testAccess(store) }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(8_000);
    await operatorLogin(page, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await page.getByRole('button', { name: '初始化演示数据', exact: true }).waitFor();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.getByRole('button', { name: '初始化演示数据', exact: true }).click(),
    ]);
    await page.getByRole('button', { name: '前往业务配置', exact: true }).waitFor();
    await page.locator('#user-select option').first().waitFor({ state: 'attached' });
    // Sending before manually creating a session must no longer look broken.
    await page.locator('#message-input').fill('你好');
    const consultation = page.waitForResponse(r => r.url().endsWith('/consult'));
    await page.locator('#send-message').click();
    const outcome = await (await consultation).json();
    assert.equal(outcome.status, 'degraded'); assert.match(outcome.answer, /业务配置/);
    assert.equal(store.listSessions('demo-user-a').length, 1);
    await page.getByRole('button', { name: '前往业务配置', exact: true }).click();
    await page.locator('#typesafe-key').fill('fake-typesafe-key-browser-only');
    await page.locator('#chat-key').fill('fake-chat-key-browser-only');
    const saved = page.waitForResponse(r => r.url().endsWith('/api/settings/models') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
    const response = await saved; assert.equal(response.status(), 200);
    assert.ok(!(await response.text()).includes('fake-typesafe-key-browser-only'));
    await page.waitForFunction(() => (document.getElementById('typesafe-key') as HTMLInputElement).value === '');
    assert.equal(await page.locator('#chat-key').inputValue(), '');
    await page.waitForFunction(() => document.getElementById('models-summary')?.textContent?.includes('Jev 已配置'));
    const reloaded = new ModelSettings(join(dir, 'model-settings.json'), {});
    assert.equal(reloaded.publicView().jevConfigured, true);
  } finally {
    await browser.close(); await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('browser: user uploads ZIP, sees enabled skill, and next consultation executes its instructions and knowledge', {
  timeout: 45_000, skip: !executablePath && 'Set BROWSER_PATH',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-skill-ui-'));
  const store = new Store(join(dir, 'ui.sqlite'));
  store.importProduct(JSON.parse(await readFile(resolve('content/templates/product.demo.json'), 'utf8')));
  store.createUser({ userId: 'skill-user', displayName: '业务编辑' });
  const service = new CustomerService(store, {
    router: { configured: true, decide: async (_input, config) => {
      assert.ok(config.skills.some(s => s.id === 'beauty-usage-guide'));
      return { ...baseRoute(config, 'BROWSER_TEST'), routeStatus: 'jev', intent: 'product_advice', emotion: 'neutral', riskLevel: 'low', primarySkill: 'beauty-usage-guide', action: 'answer' };
    } },
    generator: { configured: true, generate: async input => {
      assert.match(input.skill.instructions, /使用顺序助手/); // Title is supplied below in the template's SKILL.md.
      const fact = input.knowledge.facts.find(f => f.text.includes('演示精华'));
      assert.ok(fact);
      return { answer: '浏览器测试：已使用上传包，清洁、演示精华、演示面霜。', sourceRefs: [fact.sourceId], model: 'browser-test-only', usage: {} };
    } },
  });
  const server = createApp(store, service, { access: testAccess(store) }).listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(8_000);
    await operatorLogin(page, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await page.getByRole('button', { name: '业务配置 · Skill上传', exact: true }).click();
    await page.locator('#skill-file').setInputFiles({ name: 'author.zip', mimeType: 'application/zip', buffer: Buffer.from(SkillPackages.template()) });
    const imported = page.waitForResponse(r => r.url().endsWith('/api/skills/import'));
    await page.getByRole('button', { name: '导入并启用 Skill', exact: true }).click();
    assert.equal((await imported).status(), 200);
    await page.getByRole('heading', { name: 'beauty-usage-guide · 已启用' }).waitFor();
    await page.getByRole('button', { name: '客服测试', exact: true }).click();
    await page.locator('#message-input').fill('演示套装的使用顺序是什么？');
    const resultPromise = page.waitForResponse(r => r.url().endsWith('/consult'));
    await page.locator('#send-message').click();
    const result = await (await resultPromise).json();
    assert.equal(result.status, 'answered'); assert.equal(result.generation.skillId, 'beauty-usage-guide');
    assert.ok(result.sourceRefs.some((id: string) => id.startsWith('skill-')));
    await page.getByText('浏览器测试：已使用上传包，清洁、演示精华、演示面霜。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看完整执行证据', exact: true }).click();
    await page.getByRole('heading', { name: '真实执行时间线', exact: true }).waitFor();
    await page.getByRole('heading', { name: '实际执行文档 · beauty-usage-guide / v1', exact: true }).waitFor();
    await mkdir(resolve('test-results'), { recursive: true });
    await page.screenshot({ path: resolve('test-results/ops-run-evidence.png'), fullPage: true });
    await page.getByRole('button', { name: '业务配置 · Skill上传', exact: true }).click();
    await page.screenshot({ path: resolve('test-results/skill-upload-ui.png'), fullPage: true });
  } finally {
    await browser.close(); await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('browser: separate customer/operator contexts share a real handoff without exposing operator controls', {
  timeout: 60_000, skip: !executablePath && 'Set BROWSER_PATH',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-dual-ui-')); const store = new Store(join(dir, 'ui.sqlite'));
  store.importProduct(JSON.parse(await readFile(resolve('content/templates/product.demo.json'), 'utf8')));
  const config = loadBusinessConfig();
  const service = new CustomerService(store, { config,
    router: { configured: true, decide: async () => ({ ...baseRoute(config, 'UI_TEST'), routeStatus: 'jev', intent: 'product_advice', riskLevel: 'low', primarySkill: 'product_consult', action: 'answer' }) },
    generator: { configured: true, generate: async () => ({ answer: '这是双端浏览器测试中的资料回答。', sourceRefs: ['demo-manual'], model: 'browser-test', usage: {} }) },
  });
  const server = createApp(store, service, { access: testAccess(store) }).listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const customerContext = await browser.newContext(); const opsContext = await browser.newContext();
    const customer = await customerContext.newPage(); const operator = await opsContext.newPage();
    customer.setDefaultTimeout(10_000); operator.setDefaultTimeout(10_000);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const errors: string[] = []; customer.on('pageerror', error => errors.push(error.message)); operator.on('pageerror', error => errors.push(error.message));
    await customer.goto(base + '/'); await customer.locator('#service-status').getByText('欢迎咨询').waitFor();
    assert.equal(await customer.locator('#typesafe-key').count(), 0); assert.equal(await customer.locator('#user-select').count(), 0);
    assert.equal(await customer.locator('#route-result').count(), 0);
    await customer.locator('#profile summary').click(); await customer.locator('#preferences').fill('喜欢清爽');
    const save = customer.waitForResponse(r => r.url().endsWith('/api/customer/card') && r.request().method() === 'PATCH');
    await customer.getByRole('button', { name: '保存我的资料' }).click(); assert.equal((await save).status(), 200);
    await customer.locator('#message').fill('请介绍产品');
    const consultation = customer.waitForResponse(r => r.url().endsWith('/consult'));
    await customer.locator('#send').click();
    const result = await (await consultation).json(); assert.equal(result.route, undefined);
    await customer.getByText('这是双端浏览器测试中的资料回答。', { exact: true }).waitFor();
    assert.equal((await customerContext.request.get(base + '/api/settings/models')).status(), 401);
    await customer.locator('#human').click(); await customer.locator('#session-state').getByText('等待人工').waitFor();
    await operatorLogin(operator, base); await operator.getByRole('button', { name: '人工接管', exact: true }).click();
    await operator.getByRole('button', { name: '接管', exact: true }).click();
    await operator.getByRole('textbox', { name: '人工回复' }).fill('您好，我是本次演示坐席。');
    await operator.getByRole('button', { name: '发送人工回复', exact: true }).click();
    await customer.getByText('您好，我是本次演示坐席。', { exact: true }).waitFor();
    const sameIdentity = await customerContext.request.get(base + '/api/auth/customer/status');
    const id = (await sameIdentity.json()).userId;
    assert.deepEqual(store.getCard(id).preferences, ['喜欢清爽']);
    await customer.reload(); await customer.getByText('您好，我是本次演示坐席。', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await mkdir(resolve('test-results'), { recursive: true });
    await customer.screenshot({ path: resolve('test-results/customer-ui.png'), fullPage: true });
    await operator.getByRole('button', { name: '执行记录', exact: true }).click();
    await operator.getByRole('heading', { name: '真实执行时间线' }).waitFor();
    const downloadPromise = operator.waitForEvent('download');
    await operator.getByRole('button', { name: '下载 JSON', exact: true }).last().click();
    const downloaded = await downloadPromise;
    assert.match(downloaded.suggestedFilename(), /^beauty-run-.+\.json$/);
    await operator.screenshot({ path: resolve('test-results/operator-ui.png'), fullPage: true });
    await customerContext.close(); await opsContext.close();
  } finally {
    await browser.close(); await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('browser: customer sees sourced product cards after one guide clarification', {
  timeout: 60_000, skip: !executablePath && 'Set BROWSER_PATH',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-cards-ui-')); const store = new Store(join(dir, 'ui.sqlite'));
  store.importProduct(JSON.parse(await readFile(resolve('content/templates/product.demo.json'), 'utf8')));
  for (const product of JSON.parse(await readFile(resolve('content/templates/catalog.demo.json'), 'utf8'))) store.importProduct(product);
  const config = loadBusinessConfig();
  const service = new CustomerService(store, { config,
    router: { configured: true, decide: async () => ({ ...baseRoute(config, 'UI_TEST'), routeStatus: 'jev', intent: 'product_advice',
      riskLevel: 'low', primarySkill: 'makeup-color-synesthesia-skill', action: 'clarify',
      rawAnswers: { primary_skill: { choice: 'makeup-color-synesthesia-skill' } } }) },
    generator: { configured: true, generate: async input => ({ answer: input.responseMode === 'clarify' ? '喜欢什么风格？' : '先看两款演示商品。',
      sourceRefs: input.responseMode === 'answer' ? ['demo-lip-rose-source'] : [], model: 'browser-test', usage: {} }) },
  });
  service.skills.import({ filename: 'guide.json', content: JSON.stringify({ id: 'makeup-color-synesthesia-skill', version: 'ui-v1',
    description: '口红导购', intents: ['product_advice'], knowledgeScopes: ['product'], requiredFields: [],
    requiresKnowledge: true, recommendation: { category: '口红', maxClarifications: 1 }, instructions: '先给建议', knowledge: [] }) });
  const server = createApp(store, service, { access: testAccess(store) }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/`);
    await page.locator('#service-status').getByText('欢迎咨询').waitFor();
    await page.locator('#message').fill('想买自然的口红'); await page.locator('#send').click();
    await page.getByText('喜欢什么风格？').waitFor();
    await page.locator('#message').fill('唇色偏深，喜欢自然温柔'); await page.locator('#send').click();
    await page.locator('.product-card').first().waitFor();
    assert.equal(await page.locator('.product-card').count(), 2);
    assert.match(await page.locator('.product-card').first().innerText(), /演示商品[\s\S]*资料依据/);
  } finally {
    await browser.close(); await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});
