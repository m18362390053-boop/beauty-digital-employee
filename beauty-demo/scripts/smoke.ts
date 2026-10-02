import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operatorHeaders } from './operator-api.js';

// Start the real compiled entry on a temporary loopback port, then stop it.
const probe = createServer();
await new Promise<void>((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const port = (probe.address() as AddressInfo).port;
await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
const dataDir = await mkdtemp(join(tmpdir(), 'beauty-startup-smoke-'));
const child = spawn(process.execPath, ['dist/server/index.js'], {
  env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dataDir, 'test.sqlite') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.pipe(process.stderr);
const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Startup timed out')), 15_000);
    const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Service exited early: ${code}`)));
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.includes('Beauty demo foundation:')) { clearTimeout(timeout); resolve(); }
    });
  });
  const headers = await operatorHeaders(`http://127.0.0.1:${port}`, dataDir);
  for (const path of ['/health', '/api/products', '/api/users']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const body = await response.json() as { database?: boolean; items?: unknown[] };
    if (path === '/health' && body.database !== true) throw new Error('Database health check failed');
    console.log(JSON.stringify({ path, status: response.status, itemCount: body.items?.length, database: body.database }));
  }
  console.log('Compiled startup smoke check passed; stopping temporary server.');
} finally {
  child.kill();
  await closed;
  await rm(dataDir, { recursive: true, force: true });
}
