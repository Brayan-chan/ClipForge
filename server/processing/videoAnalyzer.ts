import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { THUMBNAILS_DIR, ensureStorageDirs } from '../db';
import { MAX_VIDEO_DURATION_SECONDS } from './validation';
import {
  isObjectStorageConfigured,
  uploadLocalFileToObjectStorage,
} from './objectStorage';
import {
  isCloudinaryConfigured,
  uploadThumbnailToCloudinary,
} from './cloudinaryImages';


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
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }


  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
  }


  return {
    ffmpegAvailable,
    ffprobeAvailable,
  };
}


export async function analyzeVideo(filePath: string): Promise<VideoMetadata> {
  const remote = filePath.startsWith('http');
  let stdout = '';
  let lastError: unknown;
  const attempts = remote ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        {
          timeout: remote ? 120000 : 15000,
          maxBuffer: 16 * 1024 * 1024,
        }
      );
      stdout = result.stdout;
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (lastError) {
    const detail = (lastError as { stderr?: string; killed?: boolean; code?: string | number }).stderr?.trim();
    const timedOut = (lastError as { killed?: boolean; code?: string | number }).killed;
    throw new Error(timedOut
      ? 'FFprobe timed out while reading the remote object after two attempts.'
      : `FFprobe could not read the video${detail ? `: ${detail.slice(0, 500)}` : '.'}`);
  }


  const parsed = JSON.parse(stdout) as {
    format?: {
      duration?: string;
    };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }>;
  };


  const videoStream = parsed.streams?.find(
    (stream) => stream.codec_type === 'video'
  );


  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error('File does not contain a valid video stream.');
  }


  const audioStream = parsed.streams?.find(
    (stream) => stream.codec_type === 'audio'
  );


  let fps = 30;


  const frameRate = videoStream.avg_frame_rate || videoStream.r_frame_rate;
  if (frameRate) {
    const [numerator, denominator] = frameRate
      .split('/')
      .map(Number);


    if (numerator && denominator && denominator > 0) {
      const parsedFps = numerator / denominator;
      if (parsedFps >= 1 && parsedFps <= 240) {
        fps = Math.round(parsedFps * 100) / 100;
      }
    }
  }


  const duration = Number(parsed.format?.duration ?? 0) || 0;


  if (duration <= 0.5) {
    throw new Error('Video duration is invalid or too short (< 0.5s).');
  }


  if (duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(
      `Video duration (${Math.round(duration)}s) exceeds the ${Math.round(
        MAX_VIDEO_DURATION_SECONDS / 60
      )}-minute limit.`
    );
  }


  return {
    duration: Math.round(duration * 100) / 100,
    width: videoStream.width,
    height: videoStream.height,
    fps,
    hasAudio: Boolean(audioStream),
    codec: videoStream.codec_name ?? 'h264',
  };
}


/**
 * Lightweight FFmpeg visual scene-change detector.
 *
 * Returns timestamps, in seconds, for visual scene cuts or major visual
 * changes. This implementation streams FFmpeg stderr instead of buffering
 * it entirely in memory, preventing:
 *
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER: stderr maxBuffer length exceeded
 */
export async function detectSceneChanges(
  videoPath: string,
  durationSeconds: number
): Promise<number[]> {
  if (videoPath.startsWith('http')) {
    return [];
  }

  const isLongVideo = durationSeconds > 600;
  const inputArgs = isLongVideo
    ? ['-skip_frame', 'nokey', '-i', videoPath]
    : ['-i', videoPath];
  const visualFilter = isLongVideo
    ? "scale=192:-2,select='gt(scene,0.055)',showinfo"
    : "scale=320:-2,select='gt(scene,0.22)',showinfo";
  return new Promise<number[]>((resolve) => {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        ...inputArgs,
        '-vf',
        visualFilter,
        '-an',
        '-f',
        'null',
        '-',
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );


    const timestamps: number[] = [];
    let pendingOutput = '';
    let stderrTail = '';


    // Dynamic timeout: enough time for longer videos, but bounded.
    const timeoutMs = Math.min(
      15 * 60 * 1000,
      Math.max(60_000, durationSeconds * (isLongVideo ? 550 : 2_000))
    );


    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      resolve(timestamps);
    }, timeoutMs);


    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');


      // Keep only the tail for error diagnostics.
      stderrTail = `${stderrTail}${text}`.slice(-10_000);


      // Process FFmpeg output incrementally.
      pendingOutput += text;


      const lines = pendingOutput.split(/\r?\n/);
      pendingOutput = lines.pop() ?? '';


      const timestampRegex = /pts_time:(\d+(?:\.\d+)?)/;


      for (const line of lines) {
        const match = timestampRegex.exec(line);


        if (!match) {
          continue;
        }


        const seconds = Number.parseFloat(match[1]);


        if (Number.isFinite(seconds)) {
          timestamps.push(Math.round(seconds * 100) / 100);
        }
      }
    });


    ffmpeg.on('error', (error) => {
      clearTimeout(timeout);
      console.warn(
        `[scene-detection] Could not start FFmpeg: ${error.message}`
      );
      resolve([]);
    });


    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);


      if (code !== 0 && code !== null) {
        console.warn(
          `[scene-detection] FFmpeg exited with code ${code}: ${stderrTail.slice(
            -800
          )}`
        );
      }


      resolve(timestamps);
    });
  });
}


export async function generateThumbnail(
  videoPath: string,
  outputFilename: string,
  timestampSeconds: number
): Promise<string | null> {
  ensureStorageDirs();


  const safeName = path.basename(outputFilename);
  const outPath = path.join(THUMBNAILS_DIR, safeName);


  try {
    await execFileAsync(
      'ffmpeg',
      [
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
      ],
      {
        timeout: videoPath.startsWith('http') ? 25000 : 15000,
        maxBuffer: 8 * 1024 * 1024,
      }
    );


    if (isCloudinaryConfigured()) {
      const uploaded = await uploadThumbnailToCloudinary(outPath, safeName);
      await fs.promises.unlink(outPath).catch(() => undefined);
      return uploaded.url;
    }
    if (isObjectStorageConfigured()) {
      const remoteUrl = await uploadLocalFileToObjectStorage({
        filePath: outPath,
        key: `thumbnails/${safeName}`,
        contentType: 'image/jpeg',
      });
      await fs.promises.unlink(outPath).catch(() => undefined);
      return remoteUrl;
    }
    return `/storage/thumbnails/${safeName}`;
  } catch {
    await fs.promises.unlink(outPath).catch(() => undefined);
    return null;
  }
}
