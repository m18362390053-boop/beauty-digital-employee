import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config } from '../server/config.js';

const source = config().databasePath;
if (!existsSync(source)) throw new Error('Database does not exist; no backup made.');
const target = resolve('data/backups', `beauty-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
await mkdir(dirname(target), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, target);
  console.log(`Consistent SQLite backup: ${target}`);
} finally { db.close(); }
