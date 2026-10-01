import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { Store } from '../server/storage/store.js';
import { CustomerService } from '../server/core/customer-service.js';
import { loadBusinessConfig, baseRoute } from '../server/core/registry.js';
import { createApp } from '../server/app.js';

const executablePath = process.env.BROWSER_PATH ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(path => existsSync(path));

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
  const server = createApp(store, service).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } });
    page.setDefaultTimeout(8_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await page.goto(base + '/demo/');
    await page.locator('#user-select option').first().waitFor({ state: 'attached' });
    await page.getByRole('button', { name: '用户资料卡', exact: true }).click();
    await page.locator('#preferences').fill('清爽\n简单步骤');
    const saved = page.waitForResponse(r => r.url().endsWith('/card') && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: '保存确认信息' }).click();
    assert.equal((await saved).status(), 200);
    await page.getByRole('button', { name: '客服咨询', exact: true }).click();
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
    await page.getByRole('button', { name: '客服咨询', exact: true }).click();
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
