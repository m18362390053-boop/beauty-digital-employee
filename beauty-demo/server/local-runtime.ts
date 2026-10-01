import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  apiKeyFiles: z.object({ TYPESAFE_API_KEY: z.string().min(1).optional(), CHAT_API_KEY: z.string().min(1).optional() }).strict().default({}),
  chat: z.object({ baseUrl: z.string().url(), model: z.string().trim().min(1), thinking: z.enum(['enabled', 'disabled']).default('disabled') }).strict().optional(),
}).strict();

export function parseKeyFile(raw: string): string {
  let value = raw.replace(/^\uFEFF/, '').trim();
  const assignment = /^(TYPESAFE_API_KEY|CHAT_API_KEY|DEEPSEEK_API_KEY|API[_ ]?KEY)\s*[:=]\s*(.+)$/i.exec(value);
  if (assignment) value = assignment[2]!.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  // Never include file content in a validation error.
  if (!/^[A-Za-z0-9_.+/=-]{16,1024}$/.test(value)) throw new Error('Credential file must contain one API key, optionally prefixed by API_KEY=.');
  return value;
}

/** Explicit local startup helper; not called from providers or ordinary unit tests. */
export function loadLocalRuntime(options: { env?: NodeJS.ProcessEnv; path?: string } = {}) {
  const env = options.env ?? process.env;
  const path = resolve(options.path ?? env.BEAUTY_LOCAL_CONFIG ?? 'config/local.json');
  const sources: Record<string, 'environment' | 'file' | 'missing'> = {};
  if (!existsSync(path)) {
    if (options.path || env.BEAUTY_LOCAL_CONFIG) throw new Error('Configured BEAUTY_LOCAL_CONFIG file does not exist.');
    return { localConfigLoaded: false, sources };
  }
  let data: z.infer<typeof schema>;
  try { data = schema.parse(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))); }
  catch { throw new Error('Invalid local runtime configuration. Check config/local.example.json; do not put key values in the configuration.'); }
  for (const name of ['TYPESAFE_API_KEY', 'CHAT_API_KEY'] as const) {
    if (env[name]?.trim()) { sources[name] = 'environment'; continue; }
    const file = data.apiKeyFiles[name];
    if (!file) { sources[name] = 'missing'; continue; }
    try { env[name] = parseKeyFile(readFileSync(resolve(dirname(path), file), 'utf8')); }
    catch { throw new Error(`Unable to load ${name} from its configured local file. Check that it exists and contains exactly one key.`); }
    sources[name] = 'file';
  }
  if (data.chat) {
    env.CHAT_BASE_URL ||= data.chat.baseUrl;
    env.CHAT_MODEL ||= data.chat.model;
    env.CHAT_THINKING ||= data.chat.thinking;
  }
  return { localConfigLoaded: true, sources };
}
