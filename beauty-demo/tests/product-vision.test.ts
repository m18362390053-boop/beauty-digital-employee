import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../server/storage/store.js';
import { ModelSettings } from '../server/core/model-settings.js';
import { ProductVision } from '../server/core/product-vision.js';
import { CustomerService } from '../server/core/customer-service.js';
import { createApp } from '../server/app.js';
import { testAccess } from './access-helper.js';
import type { AddressInfo } from 'node:net';
import { VolcanoSettings } from '../server/core/volcano.js';

const fixturePhoto = async () => ({ mediaType: 'image/png' as const,
  dataBase64: (await readFile(resolve('web/customer/assets/essence-for.png'))).toString('base64') });
const settings = (model = 'deepseek-flash', host = 'https://api.deepseek.com/v1') => new ModelSettings(undefined,
  { CHAT_API_KEY: 'test-only-no-real-model-call', CHAT_MODEL: model, CHAT_BASE_URL: host });

test('vision only proposes exact imported-name candidates from an explicitly authorised photo', async () => {
  const store = new Store(':memory:');
  try {
    const [cleanser, cream] = JSON.parse(await readFile(resolve('content/templates/routine.demo.json'), 'utf8'));
    store.importProduct(cleanser); store.importProduct(cream);
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, options) => {
      calls++;
      const request = JSON.parse(String(options?.body));
      assert.equal(request.model, 'deepseek-flash');
      assert.equal(request.messages[1].content[1].type, 'image_url');
      assert.match(request.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
      return Response.json({ model: 'deepseek-flash', choices: [{ message: { content: JSON.stringify({
        visibleName: '虚构演示洁面', visibleSpecification: '', visibleBarcode: '', visibleText: '', legible: true,
      }) } }] });
    };
    const vision = new ProductVision(store, settings(), fetchImpl);
    const image = await fixturePhoto();
    await assert.rejects(() => vision.recognize({ authorized: false, image }, new AbortController().signal));
    assert.equal(calls, 0);
    const result = await vision.recognize({ authorized: true, image }, new AbortController().signal);
    assert.equal(result.recognition, 'vision_model'); assert.equal(result.status, 'confirmation_required');
    assert.deepEqual(result.items.map(product => product.productId), ['demo-gentle-cleanser']);
    assert.equal(calls, 1);
    await assert.rejects(() => vision.recognize({ authorized: true, image: { ...image, mediaType: 'image/jpeg' } }, new AbortController().signal));
    assert.equal(calls, 1);
    assert.equal(new ProductVision(store, settings('deepseek-v4-pro'), fetchImpl).configured(), false);
    assert.equal(new ProductVision(store, settings('deepseek-flash', 'https://example.com/v1'), fetchImpl).configured(), false);
  } finally { store.close(); }
});

test('unreadable or unknown packaging never confirms or invents a SKU', async () => {
  const store = new Store(':memory:');
  try {
    store.importProduct(JSON.parse(await readFile(resolve('content/templates/routine.demo.json'), 'utf8'))[0]);
    const responses = [
      { visibleName: '虚构演示洁面', visibleSpecification: '', visibleBarcode: '', visibleText: '', legible: false },
      { visibleName: '库外产品', visibleSpecification: '130 ml', visibleBarcode: '', visibleText: '', legible: true },
    ];
    const vision = new ProductVision(store, settings(), async () => Response.json({ model: 'deepseek-flash',
      choices: [{ message: { content: JSON.stringify(responses.shift()) } }] }));
    for (const _ of [0, 1]) {
      const result = await vision.recognize({ authorized: true, image: await fixturePhoto() }, new AbortController().signal);
      assert.deepEqual(result.items, []); assert.equal(result.status, 'confirmation_required');
    }
  } finally { store.close(); }
});

test('photo endpoint requires customer cookie, CSRF and external-transfer consent; no model calls without consent', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  const modelSettings = settings();
  const vision = new ProductVision(store, modelSettings, async () => {
    calls++; return Response.json({ model: 'deepseek-flash', choices: [{ message: { content: JSON.stringify({
      visibleName: '', visibleSpecification: '', visibleBarcode: '', visibleText: '', legible: false,
    }) } }] });
  });
  const app = createApp(store, new CustomerService(store, { modelSettings }), { access: testAccess(store), vision });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const image = await fixturePhoto();
    const post = (body: unknown, cookie?: string, csrf?: string) => fetch(base + '/api/customer/packaging/recognize', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal((await post({ authorized: true, image })).status, 401);
    const auth = await fetch(base + '/api/auth/customer/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await auth.json() as { csrfToken: string };
    assert.equal((await post({ authorized: true, image }, cookie)).status, 403);
    assert.equal((await post({ authorized: false, image }, cookie, csrfToken)).status, 422);
    assert.equal(calls, 0);
    const response = await post({ authorized: true, image }, cookie, csrfToken);
    assert.equal(response.status, 200); assert.equal(calls, 1);
    assert.equal((await response.json() as { status: string }).status, 'confirmation_required');
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    store.close();
  }
});

const teamPhotos = ['SKU_01', 'SKU_02'].flatMap(sku =>
  ['front', 'back_label', 'lowlight', 'pump'].map(view =>
    resolve(`../material_from_groupmember/photos_${sku}/${sku.replace('_', '-')}_${view}.jpg`)));

test('team packaging photos exercise the offline Ark request boundary without importing unreviewed SKUs', {
  skip: teamPhotos.some(photo => !existsSync(photo)) && 'Local team materials are not part of the tracked repository',
}, async () => {
  const store = new Store(':memory:');
  const ark = new VolcanoSettings({ VOLC_ARK_API_KEY: 'mock-only', VOLC_VISION_MODEL: 'mock-image-model' });
  let calls = 0;
  try {
    const vision = new ProductVision(store, settings('unavailable'), async (url, options) => {
      calls++;
      assert.equal(String(url), 'https://ark.cn-beijing.volces.com/api/v3/responses');
      const body = JSON.parse(String(options?.body));
      assert.equal(body.model, 'mock-image-model');
      assert.equal(body.store, false);
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.match(body.input[1].content[0].image_url, /^data:image\/jpeg;base64,/);
      const bytes = Buffer.from(body.input[1].content[0].image_url.split(',')[1], 'base64');
      assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
      // Deliberately overconfident model stub: even this must not create a SKU or care event.
      return Response.json({ model: 'mock-image-model', status: 'completed', output: [{ type: 'message', content: [{
        type: 'output_text', text: JSON.stringify({
        visibleName: '欧莱雅清润葡萄籽强韧修护膜力水', visibleSpecification: '130 ml', visibleBarcode: '',
        visibleText: '', legible: true,
      }),
      }] }] });
    }, ark);
    for (const photo of teamPhotos) {
      const image = { mediaType: 'image/jpeg', dataBase64: (await readFile(photo)).toString('base64') };
      await assert.rejects(() => vision.recognize({ authorized: false, image }, new AbortController().signal));
      const result = await vision.recognize({ authorized: true, image }, new AbortController().signal);
      assert.equal(result.status, 'confirmation_required');
      assert.deepEqual(result.items, [], 'Neither team SKU is approved/imported into this isolated database');
    }
    assert.equal(calls, teamPhotos.length);
    assert.equal(store.listProducts().length, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM care_events').get()?.count, 0);
  } finally { store.close(); }
});
