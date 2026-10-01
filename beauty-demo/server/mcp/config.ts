import { z } from 'zod';
import { idSchema } from '../contracts/index.js';

export const localApiUrlSchema = z.string().url().superRefine((value, ctx) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    ctx.addIssue({ code: 'custom', message: 'Use a loopback HTTP origin, e.g. http://127.0.0.1:3090, with no credentials or path.' });
  }
});

export function mcpConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    apiUrl: localApiUrlSchema.parse(env.BEAUTY_API_URL ?? 'http://127.0.0.1:3090').replace(/\/$/, ''),
    userId: idSchema.parse(env.BEAUTY_USER_ID ?? 'demo-user-a'),
    timeoutMs: z.coerce.number().int().min(100).max(60_000).parse(env.BEAUTY_API_TIMEOUT_MS ?? '10000'),
  };
}
export type McpConfig = ReturnType<typeof mcpConfig>;
