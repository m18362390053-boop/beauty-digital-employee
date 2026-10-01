import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpConfig } from '../server/mcp/config.js';

// Read-only check of the same compiled stdio entry used by Harness.
const config = mcpConfig();
const client = new Client({ name: 'beauty-mcp-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('dist/server/mcp/index.js')],
  env: {
    BEAUTY_API_URL: config.apiUrl,
    BEAUTY_USER_ID: config.userId,
    BEAUTY_API_TIMEOUT_MS: String(config.timeoutMs),
  },
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`Tools: ${tools.map(tool => tool.name).join(', ')}`);
  for (const name of ['get_context', 'get_comments']) {
    const result = await client.callTool({ name, arguments: {} });
    const text = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text;
    if (result.isError || !text) throw new Error(`${name} failed: ${text ?? 'no text result'}`);
    const data = JSON.parse(text);
    console.log(JSON.stringify({
      tool: name, userId: data.card?.userId, dataKind: data.knowledge?.dataKind,
      approvedFacts: data.knowledge?.facts?.length, commentCount: data.total,
      businessRoutingImplemented: data.businessRoutingImplemented,
    }));
  }
  console.log('MCP → HTTP → SQLite read-only check passed; no user data changed and no model API called.');
} finally {
  await client.close();
}
