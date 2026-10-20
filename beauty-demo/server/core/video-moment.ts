import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.js';

export const VIDEO_MOMENT_SKILL_ID = 'skincare-moment-video';

const photoSchema = z.object({
  photoId: z.string().regex(/^photo-[0-9]{1,2}$/),
  originalName: z.string().trim().min(1).max(180),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  capturedAt: z.string().datetime({ offset: true }),
  dataBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(1_350_000),
}).strict();

export const videoMomentRequestSchema = z.object({
  authorized: z.literal(true),
  photos: z.array(photoSchema).min(5, '请至少选择5张照片').max(20, '一次最多选择20张照片'),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const [index, photo] of value.photos.entries()) {
    if (ids.has(photo.photoId)) ctx.addIssue({ code: 'custom', path: ['photos', index, 'photoId'], message: '照片编号重复' });
    ids.add(photo.photoId);
    totalBytes += Buffer.byteLength(photo.dataBase64, 'base64');
  }
  if (totalBytes > 12 * 1024 * 1024) ctx.addIssue({ code: 'custom', path: ['photos'], message: '压缩后的照片总大小不能超过12MB' });
});

type VideoMomentRequest = z.infer<typeof videoMomentRequestSchema>;

/**
 * Stores only explicitly authorised browser-selected images. Video rendering is deliberately
 * not simulated: until a video service is configured, jobs remain not_configured.
 */
export class VideoMomentService {
  constructor(private root: string) {}

  async create(userId: string, request: VideoMomentRequest) {
    const jobId = `moment-${randomUUID()}`;
    const destination = join(this.root, userId, jobId);
    // Validate the whole batch before creating any directory; never leave a partially saved batch.
    const prepared = request.photos.map((photo, index) => {
      const bytes = Buffer.from(photo.dataBase64, 'base64');
      if (bytes.toString('base64') !== photo.dataBase64 || bytes.length > 1_000_000 || !bytes.length) {
        throw new AppError(422, 'INVALID_MOMENT_PHOTO', '照片编码无效或超过1MB。');
      }
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!(photo.mediaType === 'image/jpeg' && jpeg || photo.mediaType === 'image/png' && png || photo.mediaType === 'image/webp' && webp)) {
        throw new AppError(422, 'INVALID_MOMENT_PHOTO', '照片内容与格式不符。');
      }
      const extension = photo.mediaType === 'image/png' ? 'png' : photo.mediaType === 'image/webp' ? 'webp' : 'jpg';
      const storedName = `${String(index + 1).padStart(2, '0')}-${photo.photoId}.${extension}`;
      return { bytes, metadata: { photoId: photo.photoId, originalName: photo.originalName, mediaType: photo.mediaType,
        capturedAt: photo.capturedAt, byteSize: bytes.byteLength, storedName } };
    });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    try {
      for (const item of prepared) await writeFile(join(destination, item.metadata.storedName), item.bytes, { mode: 0o600 });
      const photos = prepared.map(item => item.metadata);
      const dates = photos.map(photo => photo.capturedAt).sort();
      const manifest = {
        jobId, skillId: VIDEO_MOMENT_SKILL_ID, status: 'not_configured' as const,
        requestedDurationSeconds: 15, createdAt: new Date().toISOString(),
        authorized: true, photos,
      };
      await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      return {
        jobId, skillId: VIDEO_MOMENT_SKILL_ID, status: 'not_configured' as const,
        photoCount: photos.length, targetPhotoCount: 15, requestedDurationSeconds: 15,
        dateRange: { from: dates[0]!, to: dates.at(-1)! },
        message: '已收到并保存你授权的照片素材。当前没有配置视频生成服务，因此尚未生成视频文件。',
      };
    } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  }

  private jobPath(userId: string, jobId: string) {
    if (!/^moment-[0-9a-f-]{36}$/.test(jobId)) throw new AppError(404, 'MOMENT_NOT_FOUND', '未找到授权素材。');
    return join(this.root, userId, jobId);
  }
  async list(userId: string) {
    let entries: string[];
    try { entries = await readdir(join(this.root, userId)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [] }; throw error; }
    const items = [];
    for (const name of entries.filter(entry => /^moment-[0-9a-f-]{36}$/.test(entry)).slice(0, 100)) {
      try {
        const directory = this.jobPath(userId, name);
        if (!(await lstat(directory)).isDirectory()) continue;
        const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
        if (manifest.jobId !== name || !Array.isArray(manifest.photos)) continue;
        items.push({ jobId: name, status: manifest.status, createdAt: manifest.createdAt,
          photoCount: manifest.photos.length, requestedDurationSeconds: manifest.requestedDurationSeconds });
      } catch { /* Partially written jobs are not advertised. */ }
    }
    return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }
  async delete(userId: string, jobId: string) {
    const directory = this.jobPath(userId, jobId);
    try {
      if (!(await lstat(directory)).isDirectory()) throw new Error('not directory');
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
      if (manifest.jobId !== jobId) throw new Error('mismatch');
    } catch { throw new AppError(404, 'MOMENT_NOT_FOUND', '未找到你保存的授权素材。'); }
    await rm(directory, { recursive: true, force: false });
    return { jobId, deleted: true };
  }
}

export function videoMomentDataRoot(databasePath: string) {
  return join(dirname(databasePath), 'video-moment-inputs');
}
