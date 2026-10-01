import { resolve } from 'node:path';
import { z } from 'zod';

export function config() {
  return {
    host: '127.0.0.1',
    port: z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 3090),
    databasePath: resolve(process.env.DATABASE_PATH ?? './data/beauty.sqlite'),
  };
}
