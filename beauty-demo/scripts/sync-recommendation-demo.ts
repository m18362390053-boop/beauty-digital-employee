import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { Store } from '../server/storage/store.js';
import { CustomerService } from '../server/core/customer-service.js';
import { config } from '../server/config.js';

const skillRoot = resolve('skill-packages/makeup-color-synesthesia-skill');
const files: Record<string, Uint8Array> = {};
for (const name of ['SKILL.md', 'manifest.json']) files[name] = strToU8(await readFile(resolve(skillRoot, name), 'utf8'));
for (const name of await readdir(resolve(skillRoot, 'references'))) {
  if (name.endsWith('.md')) files[`references/${name}`] = strToU8(await readFile(resolve(skillRoot, 'references', name), 'utf8'));
}
const bytes = zipSync(files);
const dist = resolve('skill-packages/dist');
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, 'makeup-color-synesthesia-skill.zip'), bytes);

const store = new Store(config().databasePath);
try {
  if (store.listProducts().some(product => product.dataKind !== 'demo')) throw new Error('当前数据库包含业务产品，演示数据同步已取消。');
  const catalog = JSON.parse(await readFile(resolve('content/templates/catalog.demo.json'), 'utf8')) as unknown[];
  for (const product of catalog) console.log(store.importProduct(product));
  const service = new CustomerService(store);
  const updated = service.skills.import({ filename: 'makeup-color-synesthesia-skill.zip', content: Buffer.from(bytes).toString('base64'), encoding: 'base64' });
  console.log(`Skill ${updated.skill.id} ${updated.skill.version} 已启用；演示商品 ${catalog.length} 个已导入。`);
} finally {
  store.close();
}
