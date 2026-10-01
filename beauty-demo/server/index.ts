import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './storage/store.js';
import { CustomerService } from './core/customer-service.js';
import { loadLocalRuntime } from './local-runtime.js';

loadLocalRuntime();
const settings = config();
const store = new Store(settings.databasePath);
const service = new CustomerService(store);
service.workflows.recoverInterrupted();
const server = createApp(store, service).listen(settings.port, settings.host, () => {
  console.log(`Beauty demo foundation: http://${settings.host}:${settings.port}`);
  console.log(`Database: ${settings.databasePath}`);
  console.log(`Demo UI: http://${settings.host}:${settings.port}/demo/`);
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
