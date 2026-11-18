import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { THUMBNAILS_DIR, ensureStorageDirs } from '../db';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  codec: string;
}

export async function checkFfmpegBinaries(): Promise<{
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
}> {
  let ffmpegAvailable = false;
  let ffprobeAvailable = false;
  try {
    await execFileAsync('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  try {
    await execFileAsync('ffprobe', ['-version']);
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
  }
  return { ffmpegAvailable, ffprobeAvailable };
}

export async function analyzeVideo(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  let fps = 30;
  if (videoStream?.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (num && den && den > 0) {
      fps = Math.round((num / den) * 100) / 100;
    }
  }

  const duration = Math.max(1, Number(parsed.format?.duration ?? 0) || 0);

  return {
    duration: Math.round(duration * 100) / 100,
    width: videoStream?.width ?? 1280,
    height: videoStream?.height ?? 720,
    fps,
    hasAudio: Boolean(audioStream),
    codec: videoStream?.codec_name ?? 'h264',
  };
}

export async function generateThumbnail(
  videoPath: string,
  outputFilename: string,
  timestampSeconds: number
): Promise<string | null> {
  ensureStorageDirs();
  const outPath = path.join(THUMBNAILS_DIR, outputFilename);
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      Math.max(0, timestampSeconds).toFixed(2),
      '-i',
      videoPath,
      '-vframes',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '3',
      outPath,
    ]);
    return `/storage/thumbnails/${outputFilename}`;
  } catch {
    return null;
  }
}
