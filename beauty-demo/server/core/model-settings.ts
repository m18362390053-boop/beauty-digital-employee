import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.js';

const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
}, 'API地址必须是HTTPS或本机HTTP，不包含用户名、密码、查询参数。');
const secret = z.string().trim().min(16).max(1024).regex(/^[A-Za-z0-9_.+/=-]+$/);
export const modelSettingsPatch = z.object({
  typesafeApiKey: secret.optional(), chatApiKey: secret.optional(),
  chatBaseUrl: endpoint.optional(), chatModel: z.string().trim().min(1).max(100).optional(),
}).strict();
const storedSchema = z.object({ typesafeApiKey: z.string(), chatApiKey: z.string(), chatBaseUrl: endpoint, chatModel: z.string() }).strict();
export type ModelValues = z.infer<typeof storedSchema>;

/** Local-only configuration. The public view never returns key values. */
export class ModelSettings {
  private values: ModelValues;
  private loadWarning: string | null = null;
  constructor(private file?: string, env: NodeJS.ProcessEnv = process.env) {
    this.values = { typesafeApiKey: env.TYPESAFE_API_KEY ?? '', chatApiKey: env.CHAT_API_KEY ?? '',
      chatBaseUrl: env.CHAT_BASE_URL ?? 'https://api.deepseek.com/v1', chatModel: env.CHAT_MODEL ?? 'deepseek-flash' };
    if (file && existsSync(file)) {
      try { this.values = storedSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); }
      catch { this.loadWarning = '已保存的模型配置格式无效，已使用环境配置。请在本页重新保存。'; }
    }
    if (!endpoint.safeParse(this.values.chatBaseUrl).success) {
      this.loadWarning = '模型API地址格式无效，已回退到默认地址，请在本页检查后保存。';
      this.values.chatBaseUrl = 'https://api.deepseek.com/v1';
    }
  }
  current() { return { ...this.values }; }
  publicView() {
    return { jevConfigured: Boolean(this.values.typesafeApiKey), chatConfigured: Boolean(this.values.chatApiKey && this.values.chatModel),
      chatBaseUrl: this.values.chatBaseUrl, chatModel: this.values.chatModel, persisted: Boolean(this.file), warning: this.loadWarning,
      notice: '密钥仅用于本机后端。留空表示保留原密钥；页面不会返回密钥内容。配置验证会使用少量API额度。' };
  }
  update(input: unknown) {
    const patch = modelSettingsPatch.parse(input);
    if (!Object.keys(patch).length) throw new AppError(422, 'EMPTY_SETTINGS', '请至少填写一项。');
    const next = storedSchema.parse({ ...this.values, ...patch });
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
    }
    this.values = next;
    this.loadWarning = null;
    return this.publicView();
  }
}
