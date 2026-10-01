import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mcpConfig } from './config.js';
import { createBeautyMcpServer } from './server.js';

// stdout is reserved for MCP JSON-RPC. The HTTP backend owns all SQLite access.
const server = createBeautyMcpServer(mcpConfig());
await server.connect(new StdioServerTransport());
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
