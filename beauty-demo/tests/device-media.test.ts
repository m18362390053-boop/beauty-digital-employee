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
