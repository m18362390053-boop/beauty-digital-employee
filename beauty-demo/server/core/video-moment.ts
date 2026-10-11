import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

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
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const photos = await Promise.all(request.photos.map(async (photo, index) => {
      const bytes = Buffer.from(photo.dataBase64, 'base64');
      const extension = photo.mediaType === 'image/png' ? 'png' : photo.mediaType === 'image/webp' ? 'webp' : 'jpg';
      const storedName = `${String(index + 1).padStart(2, '0')}-${photo.photoId}.${extension}`;
      await writeFile(join(destination, storedName), bytes, { mode: 0o600 });
      return { photoId: photo.photoId, originalName: photo.originalName, mediaType: photo.mediaType,
        capturedAt: photo.capturedAt, byteSize: bytes.byteLength, storedName };
    }));
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
  }
}

export function videoMomentDataRoot(databasePath: string) {
  return join(dirname(databasePath), 'video-moment-inputs');
}
