import { z } from 'zod';
import { existsSync, readFileSync, statSync } from 'node:fs';

// Separate from the existing Jev/DeepSeek settings: no implicit key reuse or external calls.
export class VolcanoSettings {
  readonly arkKey: string;
  readonly visionModel: string;
  readonly asrModel: string;
  readonly voiceKey: string;
  readonly speaker: string;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.arkKey = env.VOLC_ARK_API_KEY ?? '';
    this.visionModel = env.VOLC_VISION_MODEL ?? '';
    this.asrModel = env.VOLC_ASR_MODEL ?? '';
    this.voiceKey = env.VOLC_VOICE_API_KEY ?? '';
    this.speaker = env.VOLC_TTS_SPEAKER ?? '';
  }
  /** Explicitly loaded for the real HTTP server; unit tests never read the user's local key. */
  static fromLocalFile(env: NodeJS.ProcessEnv, path: string) {
    if (env.VOLC_ARK_API_KEY) return new VolcanoSettings(env);
    if (!existsSync(path)) return new VolcanoSettings(env);
    if (!statSync(path).isFile() || statSync(path).size > 1024) throw new Error('Local Ark key file must be a small regular file');
    const key = readFileSync(path, 'utf8').trim();
    if (!/^ark-[A-Za-z0-9_-]{20,200}$/.test(key)) throw new Error('Local Ark key file must contain one Ark key only');
    // A key does not imply this account can call a particular model. Do not guess an enabled model.
    return new VolcanoSettings({ ...env, VOLC_ARK_API_KEY: key });
  }
  visionReady() { return Boolean(this.arkKey && this.visionModel); }
  asrReady() { return Boolean(this.arkKey && this.asrModel); }
  ttsReady() { return Boolean(this.voiceKey && this.speaker); }
}

export const speechInput = z.object({ authorized: z.literal(true), mediaType: z.enum(['audio/wav', 'audio/mpeg']),
  dataBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(100).max(2_800_000) }).strict();

export function decodedMedia(base64: string, maxBytes: number) {
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== base64) throw new Error('INVALID_MEDIA');
  return bytes;
}
