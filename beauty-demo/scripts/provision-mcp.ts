import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { idSchema } from '../server/contracts/index.js';
import { config } from '../server/config.js';
import { operatorHeaders } from './operator-api.js';
import { localApiUrlSchema } from '../server/mcp/config.js';

export async function provisionMcp(userId: string, base = 'http://127.0.0.1:3090', dataDir = dirname(config().databasePath)) {
  base = localApiUrlSchema.parse(base).replace(/\/$/, '');
  idSchema.parse(userId);
  const file = join(dataDir, `mcp-credentials-${userId}.json`);
  try {
    const existing = JSON.parse(await readFile(file, 'utf8')) as { token: string; userId: string; expiresAt: number };
    if (existing.userId === userId && existing.expiresAt > Date.now() && typeof existing.token === 'string') {
      const check = await fetch(`${base}/api/users/${userId}/card`, { headers: { Authorization: `Bearer ${existing.token}` }, signal: AbortSignal.timeout(5_000) });
      if (check.ok) return { tokenFile: file, userId, expiresAt: existing.expiresAt };
    }
  } catch { /* A missing/invalid/expired local token needs a new operator-authorized credential. */ }
  const headers = await operatorHeaders(base, dataDir);
  const response = await fetch(base + '/api/ops/mcp-credentials', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Cannot provision user-scoped MCP access: HTTP ${response.status}. Check that the user exists.`);
  const credential = await response.json() as { token: string; userId: string; expiresAt: number };
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(credential), { mode: 0o600 });
  return { tokenFile: file, userId, expiresAt: credential.expiresAt };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
  const result = await provisionMcp(value('--user', process.env.BEAUTY_USER_ID ?? 'demo-user-a'),
    value('--base', process.env.BEAUTY_API_URL ?? 'http://127.0.0.1:3090'), value('--data-dir', dirname(config().databasePath)));
  console.log(JSON.stringify(result)); // Never print the token.
}
