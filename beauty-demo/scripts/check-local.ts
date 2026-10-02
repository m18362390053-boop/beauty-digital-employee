import { loadLocalRuntime } from '../server/local-runtime.js';
import { ModelSettings } from '../server/core/model-settings.js';
import { config } from '../server/config.js';
import { dirname, join } from 'node:path';

let loaded;
try { loaded = loadLocalRuntime(); } catch { loaded = { localConfigLoaded: false, warning: 'Local credential files unavailable; check saved UI configuration.' }; }
const settings = new ModelSettings(join(dirname(config().databasePath), 'model-settings.json'));
const view = settings.publicView();
console.log(JSON.stringify({
  ...loaded,
  configured: { jev: view.jevConfigured, chat: view.chatConfigured },
  model: view.chatModel,
  savedSettingsWarning: view.warning,
  thinking: process.env.CHAT_THINKING ?? 'disabled',
}, null, 2));
