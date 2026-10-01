import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../server/storage/store.js';
import { config } from '../server/config.js';

const load = async (name: string) => JSON.parse(await readFile(resolve('content/templates', name), 'utf8'));
const settings = config();
const store = new Store(settings.databasePath);
try {
  const existing = store.listProducts();
  if (existing.some(product => product.productId !== 'demo-product' || product.dataKind !== 'demo')) {
    throw new Error('Refusing to put demo fixtures into a business database. Set DATABASE_PATH to a new demo database.');
  }
  console.log(store.importProduct(await load('product.demo.json')));
  console.log(store.importComments(await load('comments.demo.json')));
  const users = store.listUsers();
  for (const userId of ['demo-user-a', 'demo-user-b']) {
    if (!users.some(user => user.userId === userId)) store.createUser({ userId, displayName: `演示用户 ${userId.slice(-1).toUpperCase()}` });
  }
  console.log(`Demo data ready: ${settings.databasePath}`);
  console.log('All fixtures are fictional. No AI request or paid API call was made.');
} finally {
  store.close();
}
