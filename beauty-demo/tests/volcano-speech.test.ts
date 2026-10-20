import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/storage/store.js';
import { ModelSettings } from '../server/core/model-settings.js';
import { ProductVision } from '../server/core/product-vision.js';
import { VolcanoSettings } from '../server/core/volcano.js';
import { SpeechService } from '../server/core/speech.js';
import { createApp } from '../server/app.js';
import { CustomerService } from '../server/core/customer-service.js';
import { testAccess } from './access-helper.js';
import type { AddressInfo } from 'node:net';

const volc = new VolcanoSettings({ VOLC_ARK_API_KEY: 'test-ark-key', VOLC_VISION_MODEL: 'vision-fixture',
  VOLC_ASR_MODEL: 'asr-fixture', VOLC_VOICE_API_KEY: 'test-voice-key', VOLC_TTS_SPEAKER: 'fixture-speaker' });
const image = async () => ({ mediaType: 'image/png', dataBase64: (await readFile(resolve('web/customer/assets/essence-for.png'))).toString('base64') });
const audio = { authorized: true, mediaType: 'audio/wav', dataBase64: Buffer.concat([
  Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'binary'), Buffer.alloc(128),
]).toString('base64') };

test('server-only local Ark key file needs explicitly enabled model IDs and cannot act as a TTS key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-ark-file-'));
  const file = join(dir, 'ark.txt');
  try {
    await writeFile(file, `ark-${'x'.repeat(40)}\n`, { mode: 0o600 });
    const settings = VolcanoSettings.fromLocalFile({}, file);
    assert.equal(settings.visionReady(), false); assert.equal(settings.asrReady(), false);
    assert.equal(settings.ttsReady(), false); assert.equal(settings.visionModel, '');
    const enabled = VolcanoSettings.fromLocalFile({ VOLC_VISION_MODEL: 'verified-image-model', VOLC_ASR_MODEL: 'verified-audio-model' }, file);
    assert.equal(enabled.visionReady(), true); assert.equal(enabled.asrReady(), true);
    assert.equal(VolcanoSettings.fromLocalFile({ VOLC_ARK_API_KEY: 'env-only', VOLC_ASR_MODEL: 'env-model' }, file).arkKey, 'env-only');
    await writeFile(file, 'not-a-key\n');
    assert.throws(() => VolcanoSettings.fromLocalFile({}, file), /Local Ark key file/);
    assert.equal(VolcanoSettings.fromLocalFile({}, join(dir, 'missing')).visionReady(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Volcano image has priority over DeepSeek, but only returns a confirmed-by-user candidate', async () => {
  const store = new Store(':memory:');
  try {
    store.importProduct(JSON.parse(await readFile(resolve('content/templates/routine.demo.json'), 'utf8'))[0]);
    let calls = 0;
    const vision = new ProductVision(store, new ModelSettings(undefined, { CHAT_API_KEY: 'test-deepseek', CHAT_MODEL: 'deepseek-flash' }),
      async (url, options) => {
        calls++; assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/responses');
        assert.match(String(options?.headers && JSON.stringify(options.headers)), /test-ark-key/);
        const body = JSON.parse(String(options?.body)); assert.equal(body.model, 'vision-fixture');
        assert.equal(body.store, false); assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.equal(body.input[1].content[0].type, 'input_image');
        assert.match(body.input[1].content[0].image_url, /^data:image\/png;base64,/);
        return Response.json({ model: 'vision-fixture', status: 'completed', output: [{ type: 'message', content: [{
          type: 'output_text', text: JSON.stringify({ visibleName: '虚构演示洁面',
            visibleSpecification: '', visibleBarcode: '', visibleText: '', legible: true }),
        }] }] });
      }, volc);
    assert.equal(vision.provider(), 'volcano');
    const fixture = await image();
    await assert.rejects(() => vision.recognize({ authorized: false, image: fixture }, new AbortController().signal));
    assert.equal(calls, 0);
    const result = await vision.recognize({ authorized: true, image: fixture }, new AbortController().signal);
    assert.equal(result.status, 'confirmation_required'); assert.deepEqual(result.items.map(p => p.productId), ['demo-gentle-cleanser']);
  } finally { store.close(); }
});

test('Ark vision rejects incomplete Responses, non-JSON and reasoning-only output', async () => {
  const store = new Store(':memory:');
  try {
    const fixtures = [
      { model: 'vision-fixture', status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] },
      { model: 'vision-fixture', status: 'completed', output: [{ type: 'reasoning', content: [{ type: 'output_text', text: '{}' }] }] },
      { model: 'vision-fixture', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] },
    ];
    const vision = new ProductVision(store, new ModelSettings(undefined, { CHAT_API_KEY: '', CHAT_MODEL: '' }),
      async () => Response.json(fixtures.shift()), volc);
    const fixture = await image();
    for (let i = 0; i < 3; i++) await assert.rejects(() => vision.recognize({ authorized: true, image: fixture }, new AbortController().signal),
      error => error instanceof Error && error.message === 'VISION_INVALID_RESPONSE');
  } finally { store.close(); }
});

test('speech adapters require consent, reject malformed audio, and never execute the recognized words', async () => {
  let requests = 0;
  const service = new SpeechService(volc, async (url, options) => {
    requests++;
    if (String(url).endsWith('/responses')) {
      const body = JSON.parse(String(options?.body)); assert.equal(body.model, 'asr-fixture');
      assert.equal(body.store, false); assert.equal(body.max_output_tokens, 300);
      assert.match(body.input[0].content[0].audio_url, /^data:audio\/wav;base64,/);
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '好了' }] }] });
    }
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    assert.equal((options?.headers as Record<string, string>)['X-Api-Resource-Id'], 'seed-tts-2.0');
    const body = JSON.parse(String(options?.body)); assert.equal(body.req_params.speaker, 'fixture-speaker');
    const chunk = Buffer.from([0x49, 0x44, 0x33, 0, 0]);
    return new Response(`{"code":0,"data":"${chunk.toString('base64')}"}\n{"code":20000000}\n`);
  });
  const signal = new AbortController().signal;
  await assert.rejects(() => service.transcribe({ ...audio, authorized: false }, signal));
  await assert.rejects(() => service.transcribe({ ...audio, dataBase64: Buffer.alloc(128).toString('base64') }, signal));
  await assert.rejects(() => service.synthesize({ text: '您好', authorized: false }, signal));
  assert.equal(requests, 0);
  assert.deepEqual(await service.transcribe(audio, signal), { status: 'review_required', text: '好了',
    notice: '请核对转写文字后手动发送；转写本身不会推进护理或客服。' });
  assert.equal((await service.synthesize({ authorized: true, text: '您好' }, signal)).mediaType, 'audio/mpeg');
  assert.equal(requests, 2);
  const empty = new SpeechService();
  assert.equal(empty.settings.asrReady(), false); assert.equal(empty.settings.ttsReady(), false);
});

test('TTS requires a successful V3 terminal frame and rejects failed or truncated streams', async () => {
  const audioFrame = `{"code":0,"data":"${Buffer.from('ID3').toString('base64')}"}`;
  for (const stream of [
    `${audioFrame}\n`,
    `${audioFrame}\n{"code":45000001}\n`,
    '{"code":20000000}\n',
    `${audioFrame}\n{"code":20000000}\n${audioFrame}\n`,
  ]) {
    const speech = new SpeechService(volc, async () => new Response(stream));
    await assert.rejects(() => speech.synthesize({ authorized: true, text: '您好' }, new AbortController().signal),
      (error: unknown) => error instanceof Error && error.message === 'TTS_INVALID_RESPONSE');
  }
});

test('speech HTTP endpoints require identity, CSRF, consent; unconfigured calls do not leave the server', async () => {
  const store = new Store(':memory:'); let calls = 0;
  const speech = new SpeechService(volc, async () => {
    calls++; return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '好了' }] }] });
  });
  const server = createApp(store, new CustomerService(store), { access: testAccess(store), speech }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const post = (cookie?: string, csrf?: string, authorized = true) => fetch(`${base}/api/customer/speech/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify({ ...audio, authorized }),
    });
    assert.equal((await post()).status, 401);
    const auth = await fetch(`${base}/api/auth/customer/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await auth.json() as { csrfToken: string };
    assert.equal((await post(cookie)).status, 403);
    assert.equal((await post(cookie, csrfToken, false)).status, 422);
    assert.equal(calls, 0);
    const result = await post(cookie, csrfToken);
    assert.equal(result.status, 200); assert.equal((await result.json() as { text: string }).text, '好了'); assert.equal(calls, 1);
    const ops = await (await import('./access-helper.js')).loginOperator(base);
    const audit = await (await fetch(base + '/api/ops/modality-events', { headers: ops })).json() as { items: { modality: string; status: string; provider: string }[] };
    assert.equal(audit.items[0]?.modality, 'asr'); assert.equal(audit.items[0]?.status, 'succeeded');
    assert.equal(audit.items[0]?.provider, 'volcano_ark');
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); store.close();
  }
});

test('TTS HTTP only reads the current step or owned saved answer, never arbitrary or other-user text', async () => {
  const store = new Store(':memory:');
  store.importProduct(JSON.parse(await readFile(resolve('content/templates/routine.demo.json'), 'utf8'))[0]);
  let calls = 0;
  const speech = new SpeechService(volc, async (_url, options) => {
    calls++; const body = JSON.parse(String(options?.body));
    assert.ok(['已保存的测试回复', '用这款虚构演示洁面按演示说明轻柔清洁，再用清水洗净。实际产品请以包装为准。'].includes(body.req_params.text));
    return new Response(`{"code":0,"data":"${Buffer.from('ID3').toString('base64')}"}\n{"code":20000000}\n`);
  });
  const server = createApp(store, new CustomerService(store), { access: testAccess(store), speech }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const makeUser = async () => {
      const auth = await fetch(base + '/api/auth/customer/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const { userId, csrfToken } = await auth.json() as { userId: string; csrfToken: string };
      return { userId, headers: { Cookie: auth.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' } };
    };
    const first = await makeUser(); const second = await makeUser();
    const session = store.createSession(first.userId, 'demo-gentle-cleanser');
    store.db.prepare(`INSERT INTO messages(id,session_id,request_id,role,content,created_at,metadata) VALUES(?,?,?,?,?,?,?)`)
      .run('saved-answer', session.sessionId, 'answer-request', 'assistant', '已保存的测试回复', new Date().toISOString(), '{}');
    const post = (headers: Record<string, string>, body: unknown) => fetch(base + '/api/customer/speech/synthesize', {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    assert.equal((await post(first.headers, { authorized: true, text: '任意付费文字' })).status, 422);
    assert.equal((await post(second.headers, { authorized: true, messageId: 'saved-answer' })).status, 404);
    assert.equal(calls, 0);
    assert.equal((await post(first.headers, { authorized: true, messageId: 'saved-answer' })).status, 200);
    const created = await fetch(base + '/api/customer/routines', { method: 'POST', headers: first.headers,
      body: JSON.stringify({ requestId: 'tts-care', period: 'evening', productIds: ['demo-gentle-cleanser'], confirmed: true }) });
    const { routineId } = await created.json() as { routineId: string };
    assert.equal((await post(first.headers, { authorized: true, routineId })).status, 200);
    assert.equal((await post(second.headers, { authorized: true, routineId })).status, 404);
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); store.close();
  }
});
