import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { evaluate } from './evaluate.mjs';

const input = {
  state: 'The payment failed. Please fix it today.',
  questions: {
    category: { type: 'choice', instructions: 'Select department', criteria: { billing: 'Payments', support: 'Technical issues' } },
    urgency: { type: 'noul', instructions: 'Is this urgent?' },
    severity: { type: 'score', instructions: 'How severe?', criteria: ['Low', 'High'] },
  },
};

test('sends correct endpoint, authentication and mixed questions; retains usage and answers', async () => {
  const expected = { model: 'jev-test', answers: { urgency: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 4 } };
  const result = await evaluate(input, {
    apiKey: 'test-secret',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.deepEqual(JSON.parse(options.body), { ...input, model: 'jev-latest' });
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(expected);
    },
  });
  assert.deepEqual(result, expected);
});

test('invalid score and missing credentials fail before any paid request', async () => {
  const fetchImpl = () => { assert.fail('HTTP must not be called'); };
  await assert.rejects(evaluate({ ...input, questions: { bad: { type: 'score', instructions: 'Rate', criteria: ['Only one'] } } }, { apiKey: 'test', fetchImpl }));
  await assert.rejects(evaluate(input, { apiKey: '', fetchImpl }), /Missing TYPESAFE_API_KEY/);
});

test('reports HTTP errors without leaking provider response body', async () => {
  await assert.rejects(evaluate(input, {
    apiKey: 'test', fetchImpl: async () => new Response('sensitive body', { status: 429 }),
  }), error => error.message.includes('429') && !error.message.includes('sensitive'));
});

test('propagates cancellation to HTTP', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(evaluate(input, {
    apiKey: 'test', signal: controller.signal,
    fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); },
  }), { name: 'AbortError' });
});

test('MCP stdio handshake, tool discovery, and missing-key error round trip', async () => {
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
    env: { TYPESAFE_API_KEY: '' },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['evaluate']);
    const result = await client.callTool({ name: 'evaluate', arguments: input });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Missing TYPESAFE_API_KEY/);
  } finally {
    await client.close();
  }
});
