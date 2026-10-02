import { z } from 'zod';
import type { McpConfig } from './config.js';

export class BackendError extends Error {
  constructor(public code: string, message: string, public httpStatus?: number, public traceId?: string) {
    super(message);
  }
}

const errorSchema = z.object({ error: z.object({
  code: z.string().max(100), message: z.string().max(2_000), traceId: z.string().max(100).optional(),
}) });

export class BeautyApiClient {
  constructor(readonly config: McpConfig, private fetchImpl: typeof fetch = fetch) {}

  // Tools choose fixed endpoint paths. Models cannot supply arbitrary URLs.
  async request<T>(path: string, schema: z.ZodType<T>, options: {
    method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; signal?: AbortSignal; timeoutMs?: number;
  } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(`${this.config.apiUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: { Accept: 'application/json', ...(this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {}),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal,
      });
      let body: unknown;
      try { body = await response.json(); } catch (error) {
        if (signal.aborted) throw error;
        throw new BackendError('BACKEND_PROTOCOL_ERROR', 'The service did not return JSON. Check BEAUTY_API_URL.', response.status);
      }
      if (!response.ok) {
        const parsed = errorSchema.safeParse(body);
        if (parsed.success) {
          const { code, message, traceId } = parsed.data.error;
          if (code === 'OPERATOR_LOGIN_REQUIRED') throw new BackendError('BACKEND_AUTH_REQUIRED', 'Run npm run mcp:token and pass BEAUTY_API_TOKEN_FILE; MCP uses a user-scoped credential, not an operator password.', 401, traceId);
          throw new BackendError(code, message, response.status, traceId);
        }
        throw new BackendError('BACKEND_HTTP_ERROR', `Service returned HTTP ${response.status}`, response.status);
      }
      const validated = schema.safeParse(body);
      if (!validated.success) throw new BackendError('BACKEND_PROTOCOL_ERROR', 'Unexpected service response. Check service version and BEAUTY_API_URL.', response.status);
      return validated.data;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if (options.signal?.aborted) throw new BackendError('CANCELLED', 'Tool request cancelled. For a write, query its state before retrying.');
      if (timeout.aborted) throw new BackendError('BACKEND_TIMEOUT', 'Service timed out. No automatic retry was made; query state before retrying a write.');
      throw new BackendError('BACKEND_UNAVAILABLE', 'Cannot reach the beauty service. Start beauty-demo with npm start and check BEAUTY_API_URL.');
    }
  }
}
