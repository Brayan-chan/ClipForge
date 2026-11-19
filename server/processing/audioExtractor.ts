import path from 'node:path';
import { TRANSCRIPTS_DIR, ensureStorageDirs } from '../db';
import { runFfmpeg } from '../utils/ffmpegRunner';


export async function extractMonoAudio(
  videoPath: string,
  videoId: number
): Promise<string> {
  ensureStorageDirs();

  const audioPath = path.join(
    TRANSCRIPTS_DIR,
    `video-${videoId}-audio.mp3`
  );

  await runFfmpeg(
    [
      '-y',
      '-i', videoPath,

      '-vn',
      '-acodec', 'libmp3lame',
      '-ab', '48k',
      '-ar', '16000',
      '-ac', '1',

      audioPath,
    ],
    {
      timeoutMs: 10 * 60 * 1000,
      onProgress: (line) => {
        if (
          line.startsWith('frame=') ||
          line.includes('time=')
        ) {
          console.log(`[audio-extractor] ${line}`);
        }
      },
    }
  );

  return audioPath;
}