import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { Store } from '../server/storage/store.js';
import { CustomerService } from '../server/core/customer-service.js';
import { config } from '../server/config.js';

const root = resolve('skill-packages/face-area-visual-guide');
const files: Record<string, Uint8Array> = {};
for (const name of ['SKILL.md', 'manifest.json', 'references/visual-contract.md']) {
  files[name] = strToU8(await readFile(resolve(root, name), 'utf8'));
}
const bytes = zipSync(files);
const dist = resolve('skill-packages/dist');
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, 'face-area-visual-guide.zip'), bytes);

const store = new Store(config().databasePath);
try {
  const service = new CustomerService(store);
  const imported = service.skills.import({ filename: 'face-area-visual-guide.zip', content: Buffer.from(bytes).toString('base64'), encoding: 'base64' });
  console.log(`${imported.skill.id} ${imported.skill.version} 已启用。它会作为附加图示能力，在任何主Skill回答涉及受支持面部位置时显示。`);
} finally {
  store.close();
}
