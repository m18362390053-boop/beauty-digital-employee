import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './storage/store.js';
import { CustomerService } from './core/customer-service.js';
import { loadLocalRuntime } from './local-runtime.js';
import { ModelSettings } from './core/model-settings.js';
import { dirname, join } from 'node:path';
import { AccessControl } from './access.js';
import { VolcanoSettings } from './core/volcano.js';
import { ProductVision } from './core/product-vision.js';
import { SpeechService } from './core/speech.js';

try { loadLocalRuntime(); }
catch { console.error('Local credential files could not be loaded. Open /demo/ → 业务配置 to configure models.'); }
const settings = config();
const store = new Store(settings.databasePath);
const service = new CustomerService(store, { modelSettings: new ModelSettings(join(dirname(settings.databasePath), 'model-settings.json')) });
let volcano: VolcanoSettings;
try {
  // An earlier local key was exposed in chat. Do not silently reuse a default file;
  // require an explicitly configured replacement key/file and enabled model ID.
  volcano = process.env.VOLC_ARK_API_KEY_FILE
    ? VolcanoSettings.fromLocalFile(process.env, process.env.VOLC_ARK_API_KEY_FILE)
    : new VolcanoSettings();
} catch {
  console.error('Local Ark key file format is invalid; Volcano image/audio calls are disabled.');
  volcano = new VolcanoSettings({ ...process.env, VOLC_ARK_API_KEY: '', VOLC_VISION_MODEL: '', VOLC_ASR_MODEL: '' });
}
const passwordFile = join(dirname(settings.databasePath), 'operator-password.txt');
const access = new AccessControl(store, { passwordFile });
service.workflows.recoverInterrupted();
const server = createApp(store, service, { access,
  vision: new ProductVision(store, service.modelSettings, fetch, volcano), speech: new SpeechService(volcano),
}).listen(settings.port, settings.host, () => {
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
