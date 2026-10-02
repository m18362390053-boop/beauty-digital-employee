import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './storage/store.js';
import { CustomerService } from './core/customer-service.js';
import { loadLocalRuntime } from './local-runtime.js';
import { ModelSettings } from './core/model-settings.js';
import { dirname, join } from 'node:path';
import { AccessControl } from './access.js';

try { loadLocalRuntime(); }
catch { console.error('Local credential files could not be loaded. Open /demo/ → 业务配置 to configure models.'); }
const settings = config();
const store = new Store(settings.databasePath);
const service = new CustomerService(store, { modelSettings: new ModelSettings(join(dirname(settings.databasePath), 'model-settings.json')) });
const passwordFile = join(dirname(settings.databasePath), 'operator-password.txt');
const access = new AccessControl(store, { passwordFile });
service.workflows.recoverInterrupted();
const server = createApp(store, service, { access }).listen(settings.port, settings.host, () => {
  console.log(`Beauty demo foundation: http://${settings.host}:${settings.port}`);
  console.log(`Database: ${settings.databasePath}`);
  console.log(`Customer: http://${settings.host}:${settings.port}/chat/`);
  console.log(`Operator: http://${settings.host}:${settings.port}/ops/`);
  console.log(`Operator password: read the local file ${passwordFile} (or BEAUTY_OPERATOR_PASSWORD if set).`);
});
server.on('error', error => {
  console.error(`Startup failed: ${error.message}`);
  store.close();
  process.exitCode = 1;
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => store.close());
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
