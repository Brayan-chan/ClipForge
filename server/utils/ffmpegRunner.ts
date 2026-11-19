import { spawn } from 'node:child_process';

export interface FfmpegRunOptions {
  timeoutMs?: number;
  onProgress?: (line: string) => void;
}

export interface FfmpegRunResult {
  code: number | null;
  stderrTail: string;
}

/**
 * Runs FFmpeg without buffering all stderr output in memory.
 *
 * Prevents:
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER: stderr maxBuffer length exceeded
 */
export function runFfmpeg(
  args: string[],
  options: FfmpegRunOptions = {}
): Promise<FfmpegRunResult> {
  const {
    timeoutMs = 15 * 60 * 1000,
    onProgress,
  } = options;

  return new Promise<FfmpegRunResult>((resolve, reject) => {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        ...args,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );

    let stderrTail = '';
    let pendingOutput = '';

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');

      reject(
        new Error(
          `FFmpeg timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        )
      );
    }, timeoutMs);

    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');

      // Keep only the latest output for diagnostics.
      stderrTail = `${stderrTail}${text}`.slice(-20_000);

      if (!onProgress) {
        return;
      }

      pendingOutput += text;

      const lines = pendingOutput.split(/\r?\n/);
      pendingOutput = lines.pop() ?? '';

      for (const line of lines) {
        onProgress(line);
      }
    });

    ffmpeg.on('error', (error) => {
      clearTimeout(timeout);
      reject(
        new Error(`Could not start FFmpeg: ${error.message}`)
      );
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);

      if (code === 0) {
        resolve({
          code,
          stderrTail: stderrTail.slice(-2000),
        });

        return;
      }

      reject(
        new Error(
          `FFmpeg exited with code ${
            code ?? 'unknown'
          }.\n${stderrTail.slice(-3000)}`
        )
      );
    });
  });
}