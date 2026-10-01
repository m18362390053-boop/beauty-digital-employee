import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { idSchema } from '../server/contracts/index.js';
import { consultResultSchema } from '../server/core/workflow-types.js';
import { mcpConfig } from '../server/mcp/config.js';

const path = process.argv[2];
if (!path) throw new Error('Usage: npm run verify:live-mcp -- test-results/live-check-<requestId>.json');
const report = z.object({ userId: idSchema, sessionId: idSchema, requestId: idSchema, result: consultResultSchema })
  .parse(JSON.parse(await readFile(resolve(path), 'utf8')));
if (report.result.status !== 'answered') throw new Error('Choose a successful live-check report.');
const config = mcpConfig();
const signal = AbortSignal.timeout(30_000);
const prefix = `${config.apiUrl}/api/users/${report.userId}/sessions/${report.sessionId}`;
const get = async (suffix: string) => {
  const response = await fetch(prefix + suffix, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<any>;
};
const before = await get('/messages?limit=200&offset=0');
const original = before.items.find((item: { requestId: string; role: string }) => item.requestId === report.requestId && item.role === 'user');
if (!original) throw new Error('Original request message is missing; refusing to submit a new request.');
const stored = await get(`/runs/${report.requestId}`);
assert.equal(stored.state, 'completed');
assert.equal(stored.result.runId, report.result.runId);
const client = new Client({ name: 'live-result-mcp-verifier', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/server/mcp/index.js')],
    env: { BEAUTY_API_URL: config.apiUrl, BEAUTY_USER_ID: report.userId },
  }));
  const result = await client.callTool({ name: 'customer_service_consult', arguments: {
    sessionId: report.sessionId, requestId: report.requestId, content: original.content,
  } });
  assert.equal(Boolean(result.isError), false);
  const content = result.content as { type: string; text?: string }[];
  const returned = consultResultSchema.parse(JSON.parse(content.find(item => item.type === 'text')!.text!));
  assert.deepEqual(returned, report.result);
  const after = await get('/messages?limit=200&offset=0');
  assert.equal(after.total, before.total);
  const evidence = { checkedAt: new Date().toISOString(), transport: 'real-stdio-mcp-to-http',
    tool: 'customer_service_consult', replayedRunId: returned.runId, originalMessageCount: before.total,
    finalMessageCount: after.total, resultIdentical: true, submittedNewConsultation: false };
  const output = resolve('test-results', `live-mcp-check-${report.requestId}.json`);
  await writeFile(output, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(JSON.stringify({ ...evidence, report: output }, null, 2));
} finally { await client.close(); }
