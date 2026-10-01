import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { Store } from '../server/storage/store.js';
import { Workflows } from '../server/storage/workflows.js';
import { createApp } from '../server/app.js';
import { BeautyApiClient, BackendError } from '../server/mcp/api-client.js';
import { mcpConfig } from '../server/mcp/config.js';

const load = async (name: string) => JSON.parse(await readFile(resolve('content/templates', name), 'utf8'));
async function fixture(t: TestContext, seeded = true) {
  const dir = await mkdtemp(join(tmpdir(), 'beauty-mcp-'));
  const store = new Store(join(dir, 'test.sqlite'));
  if (seeded) {
    store.importProduct(await load('product.demo.json'));
    store.importComments(await load('comments.demo.json'));
    store.createUser({ userId: 'user-a', displayName: 'User A' });
    store.createUser({ userId: 'user-b', displayName: 'User B' });
  }
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>((resolveReady, reject) => {
    server.once('listening', resolveReady);
    server.once('error', reject);
  });
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done());
      server.closeIdleConnections();
    });
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function connect(userId = 'user-a') {
    const client = new Client({ name: 'beauty-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/server/mcp/index.js')],
      env: { BEAUTY_API_URL: apiUrl, BEAUTY_USER_ID: userId },
    }));
    return client;
  }
  return { store, apiUrl, connect };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  const text = content.find(item => item.type === 'text')?.text;
  assert.ok(text, 'Tool must return text JSON');
  return { isError: result.isError === true, data: JSON.parse(text) as any };
}

test('real MCP handshake discovers data and workflow tools with approved sourced knowledge', async t => {
  const { connect } = await fixture(t);
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'consultation_status', 'create_session', 'customer_service_consult', 'get_comments', 'get_context', 'list_sessions', 'record_message', 'request_handoff', 'submit_feedback', 'update_card',
  ]);
  assert.equal(tools.find(tool => tool.name === 'get_context')?.annotations?.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'update_card')?.annotations?.readOnlyHint, false);
  const context = await call(client, 'get_context');
  assert.equal(context.isError, false);
  assert.equal(context.data.card.userId, 'user-a');
  assert.equal(context.data.knowledge.dataKind, 'demo');
  assert.equal(context.data.knowledge.facts.length, 1);
  assert.equal(context.data.knowledge.facts[0].sourceId, context.data.knowledge.sources[0].sourceId);
  assert.equal(context.data.businessRoutingImplemented, true);
  const comments = await call(client, 'get_comments', { limit: 1, offset: 2 });
  assert.equal(comments.data.total, 3);
  assert.equal(comments.data.items.length, 1);
  assert.equal(comments.data.items[0].publishedAt, null);
  assert.equal(comments.data.items[0].source.sourceId, 'demo-comments-source');
});

test('MCP stores original message, deduplicates, saves card and reads it in another session', async t => {
  const { connect, store } = await fixture(t);
  const client = await connect();
  const first = (await call(client, 'create_session')).data.session;
  const messageInput = { sessionId: first.sessionId, requestId: 'original-1', content: '我偏好清爽，请记住。' };
  const original = await call(client, 'record_message', messageInput);
  assert.equal(original.isError, false);
  assert.equal(original.data.processing, 'not_implemented');
  const repeated = await call(client, 'record_message', messageInput);
  assert.equal(repeated.data.duplicate, true);
  assert.equal(repeated.data.message.messageId, original.data.message.messageId);
  const update = await call(client, 'update_card', {
    expectedVersion: 0, preferences: ['清爽'],
    confirmedFacts: { preference: { value: '清爽', sourceMessageId: original.data.message.messageId } },
  });
  assert.equal(update.isError, false);
  assert.equal(update.data.card.version, 1);
  assert.deepEqual(store.getCard('user-a').preferences, ['清爽']);
  const second = (await call(client, 'create_session')).data.session;
  assert.notEqual(first.sessionId, second.sessionId);
  const context = (await call(client, 'get_context', { sessionId: second.sessionId })).data;
  assert.deepEqual(context.card.preferences, ['清爽']);
  assert.deepEqual(context.recentMessages, []);
  const firstContext = (await call(client, 'get_context', { sessionId: first.sessionId })).data;
  assert.equal(firstContext.recentMessages.length, 1);
  assert.equal(firstContext.recentMessages[0].content, messageInput.content);
  assert.equal((await call(client, 'list_sessions')).data.items.length, 2);
});

test('server-bound identity cannot read another user session or use their message as a card source', async t => {
  const { connect, store } = await fixture(t);
  const clientA = await connect('user-a');
  const clientB = await connect('user-b');
  const sessionA = (await call(clientA, 'create_session')).data.session;
  const original = await call(clientA, 'record_message', { sessionId: sessionA.sessionId, requestId: 'a-message', content: 'A的原话' });
  for (const tool of ['get_context', 'record_message']) {
    const args = tool === 'get_context' ? { sessionId: sessionA.sessionId }
      : { sessionId: sessionA.sessionId, requestId: 'b-message', content: '不允许' };
    const result = await call(clientB, tool, args);
    assert.equal(result.isError, true);
    assert.equal(result.data.error.code, 'SESSION_NOT_FOUND');
  }
  const stolenSource = await call(clientB, 'update_card', {
    expectedVersion: 0, confirmedFacts: { invalid: { value: '借用来源', sourceMessageId: original.data.message.messageId } },
  });
  assert.equal(stolenSource.isError, true);
  assert.equal(stolenSource.data.error.code, 'INVALID_FACT_SOURCE');
  assert.equal(store.getCard('user-b').version, 0);
  assert.deepEqual((await call(clientB, 'list_sessions')).data.items, []);
});

test('HTTP version conflicts remain failed MCP tools, preserve trace ID and do not overwrite cards', async t => {
  const { connect, store } = await fixture(t);
  const client = await connect();
  store.updateCard('user-a', { expectedVersion: 0, preferences: ['已保存偏好'] });
  const stale = await call(client, 'update_card', { expectedVersion: 0, preferences: ['覆盖'] });
  assert.equal(stale.isError, true);
  assert.equal(stale.data.error.httpStatus, 409);
  assert.equal(stale.data.error.code, 'CARD_VERSION_CONFLICT');
  assert.ok(stale.data.error.traceId);
  assert.deepEqual(store.getCard('user-a').preferences, ['已保存偏好']);
  const empty = await call(client, 'update_card', { expectedVersion: 1 });
  assert.equal(empty.isError, true);
  assert.equal(empty.data.error.code, 'VALIDATION_ERROR');
});

test('unconfigured product is an explicit tool error, not fabricated customer knowledge', async t => {
  const { connect } = await fixture(t, false);
  const client = await connect();
  const result = await call(client, 'get_context');
  assert.equal(result.isError, true);
  assert.equal(result.data.error.code, 'PRODUCT_SETUP_REQUIRED');
});

test('complete MCP consultation triggers real handoff and persists status/feedback without a paid model', async t => {
  const { connect, store } = await fixture(t);
  const client = await connect();
  const session = (await call(client, 'create_session')).data.session;
  const input = { sessionId: session.sessionId, requestId: 'mcp-risk', content: '脸肿了，请转人工' };
  const result = await call(client, 'customer_service_consult', input);
  assert.equal(result.isError, false);
  assert.equal(result.data.status, 'handoff_pending');
  assert.equal(result.data.route.routeStatus, 'rule_override');
  assert.equal(result.data.route.riskLevel, 'high');
  const status = await call(client, 'consultation_status', { sessionId: session.sessionId, requestId: input.requestId });
  assert.equal(status.data.state, 'completed');
  assert.equal(status.data.result.runId, result.data.runId);
  assert.equal((await call(client, 'customer_service_consult', input)).data.runId, result.data.runId);
  const repeated = await call(client, 'request_handoff', { sessionId: session.sessionId, reason: '再次要求人工' });
  assert.equal(repeated.data.id, result.data.handoffId);
  const work = new Workflows(store);
  work.claim(result.data.handoffId);
  const reply = work.humanReply(result.data.handoffId, { requestId: 'actual-human', content: '请说明使用时间。' });
  const feedback = await call(client, 'submit_feedback', { messageId: reply.messageId, type: 'helpful' });
  assert.equal(feedback.isError, false);
  assert.equal(work.dashboard().service.helpful, 1);
});

test('MCP config accepts loopback only and rejects injected identities/credential URLs', () => {
  assert.equal(mcpConfig({}).userId, 'demo-user-a');
  assert.equal(mcpConfig({ BEAUTY_API_URL: 'http://localhost:3999/' }).apiUrl, 'http://localhost:3999');
  for (const url of ['https://remote.example', 'http://127.0.0.1:3090/other', 'http://u:secret@localhost:3090', 'http://localhost:3090/?token=secret']) {
    assert.throws(() => mcpConfig({ BEAUTY_API_URL: url }));
  }
  assert.throws(() => mcpConfig({ BEAUTY_USER_ID: '../other-user' }));
});

test('client distinguishes non-JSON, invalid success schema and disconnected backend without retries', async () => {
  const config = mcpConfig({});
  for (const response of [new Response('Not an API'), Response.json({ wrong: true })]) {
    const client = new BeautyApiClient(config, async () => response);
    await assert.rejects(client.request('/health', z.object({ status: z.literal('ok') })),
      error => error instanceof BackendError && error.code === 'BACKEND_PROTOCOL_ERROR');
  }
  let attempts = 0;
  const disconnected = new BeautyApiClient(config, async () => { attempts++; throw new TypeError('private detail'); });
  await assert.rejects(disconnected.request('/health', z.unknown()), error =>
    error instanceof BackendError && error.code === 'BACKEND_UNAVAILABLE' && !error.message.includes('private detail'));
  assert.equal(attempts, 1);
});

test('client propagates cancellation and bounded timeout without retrying writes', async () => {
  let attempts = 0;
  const waitingFetch: typeof fetch = async (_url, init) => {
    attempts++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      const keepAlive = setTimeout(() => reject(new Error('Unexpected timeout')), 2_000);
      const abort = () => { clearTimeout(keepAlive); reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  };
  const config = mcpConfig({ BEAUTY_API_TIMEOUT_MS: '100' });
  const client = new BeautyApiClient(config, waitingFetch);
  await assert.rejects(client.request('/api/example', z.unknown(), { method: 'POST', body: {} }),
    error => error instanceof BackendError && error.code === 'BACKEND_TIMEOUT');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.request('/api/example', z.unknown(), { signal: controller.signal }),
    error => error instanceof BackendError && error.code === 'CANCELLED');
  assert.equal(attempts, 2);
});
