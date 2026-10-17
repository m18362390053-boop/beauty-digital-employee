import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AppError } from './errors.js';

const execFileAsync = promisify(execFile);
const imageSchema = z.object({ imageBase64: z.string().min(100).max(8_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
const script = resolve('server/core/native-ocr.swift');
const noise = /^(?:[\d\s./,:;()（）-]+|净含量|成分|保质期|使用方法|注意事项|生产日期|限期使用日期|批号|地址|电话|www\.|https?:)/i;

export async function recognizeProductLabel(input: unknown) {
  if (process.platform !== 'darwin') throw new AppError(501, 'OCR_UNAVAILABLE', '当前服务环境暂不支持本机图片识别。');
  const { imageBase64 } = imageSchema.parse(input);
  const bytes = Buffer.from(imageBase64, 'base64');
  if (bytes.length > 5_500_000 || bytes.length < 100) throw new AppError(422, 'OCR_IMAGE_SIZE', '请选择小于 5 MB 的清晰照片。');
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png) throw new AppError(422, 'OCR_IMAGE_TYPE', '仅支持 JPG 或 PNG 图片。');
  const folder = await mkdtemp(join(tmpdir(), 'beauty-product-ocr-'));
  try {
    const imagePath = join(folder, jpeg ? 'label.jpg' : 'label.png');
    await writeFile(imagePath, bytes, { mode: 0o600 });
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('/usr/bin/swift', [script, imagePath], { timeout: 90_000, maxBuffer: 256_000 }));
    } catch {
      throw new AppError(503, 'OCR_FAILED', '图片暂时无法识别，请换一张清晰的包装正面照片，或手动填写。');
    }
    const lines = z.array(z.string()).max(100).parse(JSON.parse(stdout)).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const candidates = [...new Set(lines.filter(line => line.length >= 2 && line.length <= 80 && !noise.test(line)))].slice(0, 5);
    return { candidates, lines: lines.slice(0, 25), message: candidates.length ? '请核对识别结果，选择或修改产品名称后再加入日程。' : '没有找到清晰的产品名称，请换图或手动填写。' };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
