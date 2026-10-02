import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../server/config.js';

export async function operatorHeaders(base: string, dataDir = dirname(config().databasePath)) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Operator CLI only connects to a loopback HTTP origin.');
  }
  let password = process.env.BEAUTY_OPERATOR_PASSWORD;
  if (!password) {
    try { password = (await readFile(join(dataDir, 'operator-password.txt'), 'utf8')).trim(); }
    catch { throw new Error('Operator password unavailable. Start the backend first, or set BEAUTY_OPERATOR_PASSWORD in this terminal.'); }
  }
  const response = await fetch(base.replace(/\/$/, '') + '/api/auth/operator/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Operator login failed: HTTP ${response.status}`);
  const result = await response.json() as { csrfToken: string };
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie || !result.csrfToken) throw new Error('Operator session response is invalid');
  return { Cookie: cookie, 'X-CSRF-Token': result.csrfToken };
}
