import test from 'node:test';
import assert from 'node:assert/strict';
import { networkErrorCode, providerJson, ProviderError } from '../server/core/providers.js';

test('DNS/connect error can retry once inside the original time budget', async () => {
  let attempts = 0;
  const result = await providerJson('https://api.example.test/v1', 'test-secret', { input: 'example' }, new AbortController().signal, 3000, async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('private details'), { code: 'EAI_AGAIN' }) });
    return Response.json({ success: true });
  });
  assert.deepEqual(result, { success: true }); assert.equal(attempts, 2);
});

test('socket failures are diagnostic, not silently retried after potentially paid submission', async () => {
  let attempts = 0;
  await assert.rejects(providerJson('https://api.example.test/v1', 'test-secret', {}, new AbortController().signal, 3000, async () => {
    attempts++; throw new TypeError('private URL containing secrets', { cause: { code: 'UND_ERR_SOCKET' } });
  }), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.deepEqual(error.details, { host: 'api.example.test', networkCode: 'UND_ERR_SOCKET', attempts: 1 });
    assert.ok(!error.message.includes('secrets')); return true;
  });
  assert.equal(attempts, 1);
});

test('HTTP 401 and cancelled requests never trigger an automatic retry', async () => {
  let attempts = 0;
  await assert.rejects(providerJson('https://api.example.test', 'test-key', {}, new AbortController().signal, 3000,
    async () => { attempts++; return new Response('private body', { status: 401 }); }), /PROVIDER_HTTP_401/);
  assert.equal(attempts, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(providerJson('https://api.example.test', 'test-key', {}, controller.signal, 3000,
    async () => { attempts++; return Response.json({}); }), /PROVIDER_CANCELLED/);
  assert.equal(attempts, 1);
});

test('HTTP 404 retains only an allowlisted vendor code, never the upstream message or arbitrary body', async () => {
  let calls = 0;
  const request = (payload: string) => providerJson('https://api.example.test/v1', 'test-key', {}, new AbortController().signal, 3000,
    async () => { calls++; return new Response(payload, { status: 404 }); });
  await assert.rejects(request(JSON.stringify({ error: { code: 'InvalidEndpoint.NotFound', message: 'private image or key' } })), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'PROVIDER_HTTP_404');
    assert.deepEqual(error.details, { host: 'api.example.test', networkCode: null, attempts: 1,
      providerCode: 'InvalidEndpoint.NotFound' });
    assert.ok(!JSON.stringify(error).includes('private image or key'));
    return true;
  });
  await assert.rejects(request(JSON.stringify({ error: { code: 'private secret data', message: 'do not emit' } })), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.details?.providerCode, undefined);
    assert.ok(!JSON.stringify(error).includes('do not emit'));
    return true;
  });
  assert.equal(calls, 2);
});

test('network code extraction is bounded and rejects arbitrary messages', () => {
  assert.equal(networkErrorCode({ cause: { errors: [{ code: 'ECONNREFUSED' }] } }), 'ECONNREFUSED');
  assert.equal(networkErrorCode({ code: 'secret-key-value', message: 'do not emit' }), null);
});
