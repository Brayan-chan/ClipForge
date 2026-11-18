import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ALLOWED_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.m4v',
]);

export const MAX_VIDEO_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB
export const MAX_VIDEO_DURATION_SECONDS = 3600; // 60 minutes

export function generateSafeMediaFilename(originalName: string): string {
  const ext = path.extname(originalName || '').toLowerCase();
  const safeExt = ALLOWED_VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4';
  return `${Date.now()}-${crypto.randomUUID()}${safeExt}`;
}

export function validateUploadedFileMeta(file: {
  originalname: string;
  mimetype: string;
  size: number;
}): { valid: boolean; error?: string } {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `Unsupported extension "${ext || 'none'}". Allowed: .mp4, .mov, .webm, .mkv, .m4v.`,
    };
  }
  if (!file.mimetype.startsWith('video/') && file.mimetype !== 'application/octet-stream') {
    return {
      valid: false,
      error: `Unsupported MIME type "${file.mimetype}". Expected a video file.`,
    };
  }
  if (file.size <= 0 || file.size > MAX_VIDEO_SIZE_BYTES) {
    return {
      valid: false,
      error: `File size must be between 1 B and 250 MB.`,
    };
  }
  return { valid: true };
}

export function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup failures
  }
}
