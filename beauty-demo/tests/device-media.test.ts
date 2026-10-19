import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { CustomerService } from '../server/core/customer-service.js';
import { ProductVision } from '../server/core/product-vision.js';
import { SpeechService } from '../server/core/speech.js';
import { VolcanoSettings } from '../server/core/volcano.js';
import { createApp } from '../server/app.js';
import { testAccess, loginOperator } from './access-helper.js';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('device media requires own device token and consent; model outputs remain drafts, no care actions', async () => {
  const store = new Store(':memory:');
  let visionCalls = 0; let asrCalls = 0;
  const service = new CustomerService(store);
  const config = new VolcanoSettings({ VOLC_ARK_API_KEY: 'fake-test-key', VOLC_VISION_MODEL: 'image-fixture', VOLC_ASR_MODEL: 'asr-fixture' });
  const vision = new ProductVision(store, service.modelSettings, async () => {
    visionCalls++;
    return Response.json({ model: 'image-fixture', status: 'completed', output: [{ type: 'message', content: [{
      type: 'output_text', text: JSON.stringify({ visibleName: '', visibleSpecification: '', visibleBarcode: '', visibleText: '', legible: false }),
    }] }] });
  }, config);
  const speech = new SpeechService(config, async () => {
    asrCalls++; return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '好了' }] }] });
  });
  const server = createApp(store, service, { access: testAccess(store), vision, speech }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const auth = await fetch(base + '/api/auth/customer/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { userId } = await auth.json() as { userId: string };
    const ops = await loginOperator(base);
    const issued = await fetch(base + '/api/ops/device-credentials', { method: 'POST', headers: { ...ops, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
    const { token } = await issued.json() as { token: string };
    const image = { authorized: true, image: { mediaType: 'image/jpeg', dataBase64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(128)]).toString('base64') } };
    const audio = { authorized: true, mediaType: 'audio/wav', dataBase64: Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(128)]).toString('base64') };
    const post = (kind: string, body: unknown, bearer?: string) => fetch(base + `/api/device/media/${kind}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
    });
    assert.equal((await post('image/recognize', image)).status, 401);
    assert.equal((await post('image/recognize', image, 'invalid')).status, 401);
    assert.equal((await post('image/recognize', { ...image, authorized: false }, token)).status, 422);
    assert.equal((await post('audio/transcribe', { ...audio, authorized: false }, token)).status, 422);
    assert.equal(visionCalls, 0); assert.equal(asrCalls, 0);
    const photoResult = await post('image/recognize', image, token);
    assert.equal(photoResult.status, 200);
    assert.equal((await photoResult.json() as { status: string }).status, 'confirmation_required');
    const speechResult = await post('audio/transcribe', audio, token);
    assert.equal(speechResult.status, 200);
    assert.deepEqual(await speechResult.json(), { status: 'review_required', text: '好了', notice: '请核对转写文字后手动发送；转写本身不会推进护理或客服。' });
    assert.equal(visionCalls, 1); assert.equal(asrCalls, 1);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM care_events').get() as { n: number }).n, 0);
    await fetch(base + `/api/ops/device-credentials/${userId}`, { method: 'DELETE', headers: ops });
    assert.equal((await post('audio/transcribe', audio, token)).status, 401);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); store.close();
  }
});

test('device TTS speaks only an owned current step and requires explicit authorization', async () => {
  const store = new Store(':memory:');
  const [product] = JSON.parse(await readFile(resolve('content/templates/routine.demo.json'), 'utf8'));
  store.importProduct(product);
  let calls = 0;
  const speech = new SpeechService(new VolcanoSettings({ VOLC_VOICE_API_KEY: 'mock', VOLC_TTS_SPEAKER: 'mock' }), async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(String(options?.body)).req_params.text, '用这款虚构演示洁面按演示说明轻柔清洁，再用清水洗净。实际产品请以包装为准。');
    return new Response(`{"code":0,"data":"${Buffer.from('ID3').toString('base64')}"}\n{"code":20000000}\n`);
  });
  const service = new CustomerService(store);
  const server = createApp(store, service, { access: testAccess(store), speech }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const auth = await fetch(base + '/api/auth/customer/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { userId } = await auth.json() as { userId: string };
    const ops = await loginOperator(base);
    const issued = await fetch(base + '/api/ops/device-credentials', { method: 'POST', headers: { ...ops, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
    const { token } = await issued.json() as { token: string };
    const run = new (await import('../server/core/routines.js')).Routines(store).start(userId, {
      requestId: 'tts-demo', period: 'evening', productIds: [product.productId], confirmed: true,
    });
    const send = (body: unknown, bearer?: string) => fetch(base + '/api/device/speech/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal((await send({ authorized: true, routineId: run.routineId })).status, 401);
    assert.equal((await send({ authorized: false, routineId: run.routineId }, token)).status, 422);
    assert.equal((await send({ authorized: true, routineId: run.routineId, text: 'arbitrary' }, token)).status, 422);
    assert.equal((await send({ authorized: true, routineId: 'not-owned' }, token)).status, 404);
    assert.equal(calls, 0);
    const result = await send({ authorized: true, routineId: run.routineId }, token);
    assert.equal(result.status, 200);
    assert.equal((await result.json() as { mediaType: string }).mediaType, 'audio/mpeg');
    assert.equal(calls, 1);
    await fetch(base + `/api/ops/device-credentials/${userId}`, { method: 'DELETE', headers: ops });
    assert.equal((await send({ authorized: true, routineId: run.routineId }, token)).status, 401);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); store.close();
  }
});
