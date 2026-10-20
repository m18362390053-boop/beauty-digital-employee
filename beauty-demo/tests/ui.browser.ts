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
import { FACE_GUIDE_SKILL_ID } from '../server/core/face-guides.js';
import { ProductVision } from '../server/core/product-vision.js';
import { SpeechService } from '../server/core/speech.js';
import { VolcanoSettings } from '../server/core/volcano.js';
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
    const errors: string[] = []; const missingAssets: string[] = [];
    customer.on('pageerror', error => errors.push(error.message)); operator.on('pageerror', error => errors.push(error.message));
    customer.on('response', response => {
      if (response.status() === 404 && new URL(response.url()).pathname.startsWith('/chat/')) missingAssets.push(response.url());
    });
    await customer.goto(base + '/'); await customer.locator('#service-status').getByText('欢迎咨询').waitFor();
    assert.equal(await customer.locator('#home-view').isVisible(), true);
    assert.equal(await customer.locator('#consult-view').isVisible(), false);
    await customer.locator('#start-consultation').click();
    await customer.locator('#consult-view').waitFor({ state: 'visible' });
    assert.equal(await customer.locator('#typesafe-key').count(), 0); assert.equal(await customer.locator('#user-select').count(), 0);
    assert.equal(await customer.locator('#route-result').count(), 0);
    await customer.locator('#profile summary').click(); await customer.locator('#preferences').fill('喜欢清爽');
    const save = customer.waitForResponse(r => r.url().endsWith('/api/customer/card') && r.request().method() === 'PATCH');
    await customer.getByRole('button', { name: '保存我的资料' }).click(); assert.equal((await save).status(), 200);
    await customer.getByText('已保存，下次咨询会参考这些信息。', { exact: true }).waitFor();
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
    assert.deepEqual(missingAssets, []);
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
    await page.locator('#start-consultation').click();
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

test('browser: face-area diagram shows a pausable under-eye highlight with separate application boundary', {
  timeout: 45_000, skip: !executablePath && 'Set BROWSER_PATH',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-face-ui-')); const store = new Store(join(dir, 'ui.sqlite'));
  store.importProduct(JSON.parse(await readFile(resolve('content/templates/product.demo.json'), 'utf8')));
  const config = loadBusinessConfig();
  const service = new CustomerService(store, { config,
    router: { configured: true, decide: async () => ({ ...baseRoute(config, 'UI_TEST'), routeStatus: 'jev', intent: 'product_advice',
      riskLevel: 'low', primarySkill: FACE_GUIDE_SKILL_ID, action: 'answer' }) },
    generator: { configured: true, generate: async () => ({ answer: '卧蚕就在下睫毛下面。眼周产品请先看标签，再轻点涂开。',
      sourceRefs: [], model: 'browser-test', usage: {} }) },
  });
  service.skills.import({ filename: 'face-guide.json', content: JSON.stringify({ id: FACE_GUIDE_SKILL_ID, version: 'ui-v1',
    description: '面部位置示意', intents: ['product_advice'], knowledgeScopes: ['product'], requiredFields: [],
    requiresKnowledge: false, instructions: '区分部位位置和产品涂抹范围', knowledge: [] }) });
  const server = createApp(store, service, { access: testAccess(store) }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/`);
    await page.locator('#start-consultation').click();
    await page.locator('#message').fill('卧蚕在哪里，怎么涂眼霜？');
    const response = page.waitForResponse(r => r.url().endsWith('/consult'));
    await page.locator('#send').click();
    assert.equal((await (await response).json()).visualGuide.region, 'under_eye');
    await page.locator('.face-guide svg[role="img"]').waitFor();
    assert.equal(await page.locator('.face-guide .face-highlight').count(), 2);
    assert.equal(await page.locator('.face-guide .face-application-boundary').count(), 1);
    await page.getByRole('button', { name: '暂停高亮' }).click();
    assert.equal(await page.locator('.face-guide.paused').count(), 1);
    assert.match(await page.locator('.face-guide').innerText(), /不是按摩路线/);
    await mkdir(resolve('test-results'), { recursive: true });
    await page.locator('.face-guide[data-region="under_eye"]').screenshot({ path: resolve('test-results/face-area-guide.png') });
    for (const [question, region, screenshot] of [
      ['油皮区域一般是哪里？', 't_zone', 'face-t-zone.png'],
      ['法令纹具体在哪里？', 'nasolabial_fold', 'face-nasolabial-fold.png'],
      ['鼻翼旁容易起死皮是哪里？', 'flaky_area', 'face-flaky-area.png'],
      ['面霜怎么涂到脸上？', 'full_face', 'face-full-face.png'],
    ] as const) {
      await page.locator('#message').fill(question);
      const next = page.waitForResponse(r => r.url().endsWith('/consult'));
      await page.locator('#send').click();
      assert.equal((await (await next).json()).visualGuide.region, region);
      await page.locator(`.face-guide[data-region="${region}"]`).waitFor();
      await page.locator(`.face-guide[data-region="${region}"]`).screenshot({ path: resolve(`test-results/${screenshot}`) });
    }
  } finally {
    await browser.close(); await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('browser: a customer confirms a product, completes one step, skips another and corrects a record', {
  timeout: 45_000, skip: !executablePath && 'Set BROWSER_PATH',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-care-ui-')); const store = new Store(join(dir, 'ui.sqlite'));
  for (const product of JSON.parse(await readFile(resolve('content/templates/routine.demo.json'), 'utf8'))) store.importProduct(product);
  const server = createApp(store, undefined, { access: testAccess(store) }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(8_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/`);
    await page.getByRole('button', { name: '开始咨询' }).click();
    await page.locator('#care-products option').first().waitFor();
    await page.locator('#package-text').fill('我手里有虚构演示洁面和虚构演示面霜');
    await page.locator('#find-care-products').click();
    await page.getByText('找到 2 个文字匹配候选', { exact: false }).waitFor();
    await page.locator('#start-care').click();
    await page.locator('.care-step').getByText('第 1 / 2 步', { exact: false }).waitFor();
    await page.getByRole('button', { name: '重说', exact: true }).click();
    assert.equal(await page.locator('.care-step').count(), 1);
    await page.getByRole('button', { name: '好了，完成这一步' }).click();
    await page.locator('.care-step').getByText('第 2 / 2 步', { exact: false }).waitFor();
    const operator = await browser.newPage();
    await operatorLogin(operator, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await operator.getByRole('button', { name: '护理记录', exact: true }).click();
    await operator.getByText('来源：虚构护肤流程演示资料：洁面', { exact: false }).waitFor();
    await page.getByRole('button', { name: '跳过（不记录完成）' }).click();
    await page.getByText('本次流程已结束。只有确认过的步骤才会留下完成记录。').waitFor();
    assert.equal(await page.locator('.care-event').count(), 1);
    page.once('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: '删除误记' }).click();
    await page.getByText('还没有已确认的护理记录。').waitFor();
    await operator.getByRole('button', { name: '刷新护理记录' }).click();
    await operator.getByText('已撤销', { exact: false }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('browser: authorised product photo yields an unconfirmed candidate that the customer can bind to a new consultation', {
  timeout: 45_000, skip: !executablePath && 'Set BROWSER_PATH',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-vision-ui-')); const store = new Store(join(dir, 'ui.sqlite'));
  const [cleanser] = JSON.parse(await readFile(resolve('content/templates/routine.demo.json'), 'utf8'));
  store.importProduct(cleanser);
  const modelSettings = new ModelSettings(undefined, {
    CHAT_API_KEY: 'test-only-no-external-call', CHAT_MODEL: 'deepseek-flash', CHAT_BASE_URL: 'https://api.deepseek.com/v1',
  });
  const service = new CustomerService(store, { modelSettings });
  const vision = new ProductVision(store, modelSettings, async () => Response.json({ model: 'browser-test-vision',
    choices: [{ message: { content: JSON.stringify({ visibleName: '', visibleSpecification: '',
      visibleBarcode: '', visibleText: '虚构演示洁面 <script>not html</script>', legible: true }) } }] }));
  const server = createApp(store, service, { access: testAccess(store), vision }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(8_000);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/`);
    await page.getByRole('button', { name: '开始咨询' }).click();
    await page.locator('#care-photo-status').getByText('已配置但尚未验证效果', { exact: false }).waitFor();
    await page.locator('#care-photo').setInputFiles(resolve('web/customer/assets/essence-for.png'));
    await page.locator('#care-photo-preview').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#recognize-care-photo').isDisabled(), true);
    await page.locator('#care-photo-authorize').check();
    const response = page.waitForResponse(r => r.url().endsWith('/api/customer/packaging/recognize'));
    await page.locator('#recognize-care-photo').click();
    assert.equal((await response).status(), 200);
    await page.getByText('模型读到的其他文字（未经商品审核）：虚构演示洁面 <script>not html</script>').waitFor();
    assert.equal(await page.locator('#care-photo-candidates script').count(), 0);
    await page.getByRole('button', { name: /我确认是 虚构演示洁面/ }).waitFor();
    assert.equal(store.listUsers().length, 1);
    await page.getByRole('button', { name: /我确认是 虚构演示洁面/ }).click();
    assert.equal(await page.locator('#product-select').inputValue(), 'demo-gentle-cleanser');
    await page.getByText('已用你确认的 虚构演示洁面 开始新咨询', { exact: false }).waitFor();
    const userId = (store.listUsers()[0] as { userId: string }).userId;
    assert.equal((store.listSessions(userId)[0] as { productId: string }).productId, 'demo-gentle-cleanser');
  } finally {
    await browser.close(); await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('browser: configured speech offers reviewed draft and step narration; playback failure keeps written instruction', {
  timeout: 45_000, skip: !executablePath && 'Set BROWSER_PATH',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-speech-ui-')); const store = new Store(join(dir, 'ui.sqlite'));
  const [product] = JSON.parse(await readFile(resolve('content/templates/routine.demo.json'), 'utf8'));
  store.importProduct(product);
  const speech = new SpeechService(new VolcanoSettings({ VOLC_ARK_API_KEY: 'only-mock', VOLC_ASR_MODEL: 'test-audio',
    VOLC_VOICE_API_KEY: 'only-mock', VOLC_TTS_SPEAKER: 'mock-speaker' }), async (url, options) => {
    if (String(url).endsWith('/responses')) {
      const request = JSON.parse(String(options?.body));
      assert.match(request.input[0].content[0].audio_url, /^data:audio\/wav;base64,/);
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '好了' }] }] });
    }
    return new Response(`{"code":0,"data":"${Buffer.from('ID3').toString('base64')}"}\n{"code":20000000}\n`);
  });
  const server = createApp(store, undefined, { access: testAccess(store), speech }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(8_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/`);
    await page.getByRole('button', { name: '开始咨询' }).click();
    await page.locator('#record-consult').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#record-consult').isDisabled(), false);
    assert.equal(await page.locator('#speak-care').isDisabled(), true);
    await page.locator('#care-products option').first().waitFor();
    await page.locator('#care-products').selectOption(['demo-gentle-cleanser']);
    await page.locator('#start-care').click();
    await page.locator('.care-step').getByText('第 1 / 1 步', { exact: false }).waitFor();
    const response = page.waitForResponse(result => result.url().endsWith('/api/customer/speech/synthesize'));
    await page.locator('#speak-care').click(); assert.equal((await response).status(), 200);
    await page.getByText('暂时无法朗读，请阅读屏幕上的步骤文字。').waitFor();
    assert.match(await page.locator('.care-step').textContent() ?? '', /虚构演示洁面/);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM care_events').get()?.count, 0);
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext(); const output = context.createMediaStreamDestination();
        const tone = context.createOscillator(); tone.connect(output); tone.start();
        return output.stream;
      };
    });
    await page.locator('#record-care').click();
    await page.locator('#stop-recording').waitFor({ state: 'visible' });
    await page.waitForTimeout(700); // Give MediaRecorder enough audio frames to create a decodable WebM recording.
    const transcribed = page.waitForResponse(result => result.url().endsWith('/api/customer/speech/transcribe'));
    await page.locator('#stop-recording').click(); assert.equal((await transcribed).status(), 200);
    await page.getByText('转写已填入草稿；核对无误后请手动点击发送。').waitFor();
    assert.equal(await page.locator('#care-command').inputValue(), '好了');
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM care_events').get()?.count, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});
