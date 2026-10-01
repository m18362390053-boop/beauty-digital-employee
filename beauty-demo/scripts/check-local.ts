import { loadLocalRuntime } from '../server/local-runtime.js';

const loaded = loadLocalRuntime();
console.log(JSON.stringify({
  ...loaded,
  configured: { jev: Boolean(process.env.TYPESAFE_API_KEY), chat: Boolean(process.env.CHAT_API_KEY && process.env.CHAT_MODEL) },
  model: process.env.CHAT_MODEL ?? null,
  thinking: process.env.CHAT_THINKING ?? 'disabled',
}, null, 2));
