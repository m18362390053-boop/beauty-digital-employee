import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLocalRuntime, parseKeyFile } from '../server/local-runtime.js';
import { ChatProvider } from '../server/core/providers.js';
import { loadBusinessConfig } from '../server/core/registry.js';

test('local credential loader respects env priority and resolves relative paths without copying keys to config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-keys-test-'));
  try {
    await mkdir(join(dir, 'config'));
    const configPath = join(dir, 'config', 'local.json');
    const config = { apiKeyFiles: { TYPESAFE_API_KEY: '../typesafe.txt', CHAT_API_KEY: '../not-needed.txt' }, chat: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', thinking: 'disabled' } };
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(join(dir, 'typesafe.txt'), '\uFEFFAPI_KEY="test-typesafe-secret-value"\n');
    const env: NodeJS.ProcessEnv = { CHAT_API_KEY: 'existing-env-key-value' };
    const result = loadLocalRuntime({ env, path: configPath });
    assert.equal(env.TYPESAFE_API_KEY, 'test-typesafe-secret-value');
    assert.equal(env.CHAT_API_KEY, 'existing-env-key-value');
    assert.equal(env.CHAT_MODEL, 'deepseek-flash');
    assert.deepEqual(result.sources, { TYPESAFE_API_KEY: 'file', CHAT_API_KEY: 'environment' });
    assert.ok(!JSON.stringify(result).includes('secret-value'));
    await writeFile(join(dir, 'typesafe.txt'), 'not valid\nsecret content');
    assert.throws(() => loadLocalRuntime({ env: {}, path: configPath }), error => error instanceof Error && !error.message.includes('secret content'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('credential parser rejects instructions/multiple tokens; absent default config does not alter environment', () => {
  assert.equal(parseKeyFile('sk-test-secret-value\n'), 'sk-test-secret-value');
  for (const value of ['short', 'a-key-with-enough-length\nb-key-with-enough-length', '<script>secret</script>']) {
    assert.throws(() => parseKeyFile(value));
  }
  assert.throws(() => loadLocalRuntime({ path: 'does-not-exist.local.json', env: {} }), /does not exist/);
});

test('DeepSeek Flash requests disable thinking and require JSON; generic providers receive no DeepSeek-only flags', async () => {
  const config = loadBusinessConfig();
  const input = { userText: '说明产品', card: { userId: 'u', confirmedFacts: {}, preferences: [], concerns: [], version: 0, updatedAt: '' }, recentMessages: [],
    skill: config.skills[0]!, knowledge: { productId: 'p', name: 'demo', version: 'v1', dataKind: 'demo' as const,
      sources: [{ sourceId: 'source', title: 'demo', locator: 'demo://source', collectedAt: '' }],
      facts: [{ factId: 'fact', category: 'description' as const, text: 'demo', sourceId: 'source', reviewStatus: 'approved' as const }] }, comments: [] };
  for (const baseUrl of ['https://api.deepseek.com/v1', 'https://other.example/v1']) {
    const provider = new ChatProvider({ apiKey: 'test-key', baseUrl, model: 'deepseek-flash' }, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (baseUrl.includes('api.deepseek.com')) {
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.deepEqual(body.response_format, { type: 'json_object' });
      } else { assert.equal(body.thinking, undefined); assert.equal(body.response_format, undefined); }
      return Response.json({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: '{"answer":"演示回答","sourceRefs":["source"]}' } }] });
    });
    assert.equal((await provider.generate(input, new AbortController().signal)).model, 'deepseek-flash');
  }
});
