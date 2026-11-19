import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type {
  AspectRatio,
  ClipComposition,
  ClipRecord,
  SubtitleStyle,
  TranscriptSegment,
} from '../../src/types';
import {
  getClipComposition,
  type CompositionVariant,
} from '../../src/utils/composition';
import { CLIPS_DIR, ensureStorageDirs } from '../db';
import { generateThumbnail } from './videoAnalyzer';


let assFilterSupport: Promise<boolean> | null = null;
let subtitlesFilterSupport: Promise<boolean> | null = null;
let drawtextFilterSupport: Promise<boolean> | null = null;
let videoToolboxSupport: Promise<boolean> | null = null;


interface FfmpegRunResult {
  code: number | null;
  stderrTail: string;
}


function runFfmpeg(
  args: string[],
  timeoutMs = 15 * 60 * 1000
): Promise<FfmpegRunResult> {
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

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');

      reject(
        new Error(
          `FFmpeg timed out after ${Math.round(
            timeoutMs / 1000
          )} seconds.`
        )
      );
    }, timeoutMs);

    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');

      stderrTail = `${stderrTail}${text}`.slice(-20_000);

      if (
        text.includes('frame=') ||
        text.includes('time=')
      ) {
        console.log(
          `[FFmpeg render] ${text.trim().slice(-180)}`
        );
      }
    });

    ffmpeg.on('error', (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Could not start FFmpeg: ${error.message}`
        )
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


async function runFfmpegWithOutput(
  args: string[],
  timeoutMs = 10000
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const ffmpeg = spawn(
      'ffmpeg',
      ['-hide_banner', ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error('FFmpeg command timed out.'));
    }, timeoutMs);

    ffmpeg.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    // Depending on the FFmpeg build, capability listings are written to
    // stdout or stderr. Capture both so feature detection is reliable.
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    ffmpeg.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);

      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new Error(
          `FFmpeg exited with code ${code ?? 'unknown'}.`
        )
      );
    });
  });
}


function supportsAssFilter(): Promise<boolean> {
  if (!assFilterSupport) {
    assFilterSupport = runFfmpegWithOutput(
      ['-filters'],
      10000
    )
      .then((stdout) =>
        /\bass\s+V->V\b/.test(stdout)
      )
      .catch(() => false);
  }

  return assFilterSupport;
}


function supportsSubtitlesFilter(): Promise<boolean> {
  if (!subtitlesFilterSupport) {
    subtitlesFilterSupport = runFfmpegWithOutput(
      ['-filters'],
      10000
    )
      .then((stdout) =>
        /\bsubtitles\s+V->V\b/.test(stdout)
      )
      .catch(() => false);
  }

  return subtitlesFilterSupport;
}


function supportsDrawtextFilter(): Promise<boolean> {
  if (!drawtextFilterSupport) {
    drawtextFilterSupport = runFfmpegWithOutput(
      ['-filters'],
      10000
    )
      .then((stdout) =>
        /\bdrawtext\s+V->V\b/.test(stdout)
      )
      .catch(() => false);
  }

  return drawtextFilterSupport;
}


function supportsVideoToolboxEncoder(): Promise<boolean> {
  if (!videoToolboxSupport) {
    videoToolboxSupport = runFfmpegWithOutput(
      ['-encoders'],
      10000
    )
      .then((output) => /\bh264_videotoolbox\b/.test(output))
      .catch(() => false);
  }

  return videoToolboxSupport;
}


function formatSrtTime(timeSeconds: number): string {
  const totalSeconds = Math.max(0, timeSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(
    (totalSeconds % 3600) / 60
  );
  const wholeSeconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.round(
    (totalSeconds - Math.floor(totalSeconds)) * 1000
  );

  return `${String(hours).padStart(2, '0')}:${String(
    minutes
  ).padStart(2, '0')}:${String(wholeSeconds).padStart(
    2,
    '0'
  )},${String(milliseconds).padStart(3, '0')}`;
}


function formatAssTime(timeSeconds: number): string {
  const totalSeconds = Math.max(0, timeSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(
    (totalSeconds % 3600) / 60
  );
  const wholeSeconds = Math.floor(totalSeconds % 60);
  const centiseconds = Math.floor(
    (totalSeconds - Math.floor(totalSeconds)) * 100
  );

  return `${hours}:${String(minutes).padStart(
    2,
    '0'
  )}:${String(wholeSeconds).padStart(
    2,
    '0'
  )}.${String(centiseconds).padStart(2, '0')}`;
}


function hexToAssBgr(
  hex: string,
  alphaHex = '00'
): string {
  const cleaned = hex.replace('#', '').trim();

  if (cleaned.length !== 6) {
    return `&H${alphaHex}FFFFFF`;
  }

  const red = cleaned.slice(0, 2);
  const green = cleaned.slice(2, 4);
  const blue = cleaned.slice(4, 6);

  return `&H${alphaHex}${blue}${green}${red}`.toUpperCase();
}


function getTargetDimensions(
  aspectRatio: AspectRatio
): { width: number; height: number } {
  switch (aspectRatio) {
    case '1:1':
      return {
        width: 720,
        height: 720,
      };
    case '16:9':
      return {
        width: 1280,
        height: 720,
      };
    case '9:16':
    default:
      return {
        width: 720,
        height: 1280,
      };
  }
}


function buildClipSegments(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number
): TranscriptSegment[] {
  return segments
    .filter(
      (segment) =>
        segment.end > clipStart &&
        segment.start < clipEnd
    )
    .map((segment, index) => ({
      id: segment.id || `sub-${index + 1}`,
      start: Math.max(
        0,
        segment.start - clipStart
      ),
      end: Math.max(
        0.4,
        Math.min(
          clipEnd - clipStart,
          segment.end - clipStart
        )
      ),
      text: segment.text.trim(),
    }))
    .filter((segment) => segment.text.length > 0);
}


function writeSrtFile(
  filePath: string,
  clipSegments: TranscriptSegment[]
): void {
  const srt = clipSegments
    .map(
      (segment, index) =>
        `${index + 1}\n${formatSrtTime(
          segment.start
        )} --> ${formatSrtTime(
          segment.end
        )}\n${segment.text}`
    )
    .join('\n\n');

  fs.writeFileSync(
    filePath,
    `${srt}\n`,
    'utf-8'
  );
}


function writeAssFile(
  filePath: string,
  clipSegments: TranscriptSegment[],
  style: SubtitleStyle,
  width: number,
  height: number,
  creditText = ''
): void {
  const scaledFontSize = Math.round(
    (style.fontSize || 22) * (width / 420)
  );

  const primaryColor = hexToAssBgr(
    style.textColor || '#FFFFFF',
    '00'
  );

  const secondaryColor = hexToAssBgr(
    style.highlightColor || '#22C55E',
    '00'
  );

  const backColor = style.backgroundBox
    ? '&H66000000'
    : '&H00000000';

  const outlineColor = '&H00000000';
  const borderStyle = style.backgroundBox ? 3 : 1;
  const outline = style.backgroundBox ? 8 : 3;
  const shadow = style.backgroundBox ? 0 : 2;

  let alignment = 2;

  const columnOffset =
    style.alignment === 'left'
      ? -1
      : style.alignment === 'right'
      ? 1
      : 0;

  if (style.position === 'top') {
    alignment = 8 + columnOffset;
  } else if (style.position === 'center') {
    alignment = 5 + columnOffset;
  } else {
    alignment = 2 + columnOffset;
  }

  const marginV =
    style.position === 'center'
      ? 0
      : Math.round(height * 0.11);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0


[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,${scaledFontSize},${primaryColor},${secondaryColor},${outlineColor},${backColor},-1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},40,40,${marginV},1


[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const subtitleEvents = clipSegments
    .flatMap((segment) => {
      const cleanText = segment.text
        .replace(/\\/g, '')
        .replace(/\{|\}/g, '')
        .replace(/\r?\n/g, ' ')
        .trim();

      const words = cleanText
        .split(/\s+/)
        .filter(Boolean);

      if (words.length === 0) {
        return [];
      }

      const wordDuration = Math.max(
        0.04,
        (segment.end - segment.start) / words.length
      );

      const region = style.region;

      const regionOverride = region
        ? `{\\an5\\pos(${Math.round(
            width *
              ((region.x + region.width / 2) / 100)
          )},${Math.round(
            height *
              ((region.y + region.height / 2) / 100)
          )})\\clip(${Math.round(
            (width * region.x) / 100
          )},${Math.round(
            (height * region.y) / 100
          )},${Math.round(
            (width * (region.x + region.width)) / 100
          )},${Math.round(
            (height * (region.y + region.height)) / 100
          )})}`
        : '';

      return words.map((_, activeIndex) => {
        const start =
          segment.start + activeIndex * wordDuration;

        const end =
          activeIndex === words.length - 1
            ? segment.end
            : Math.min(
                segment.end,
                start + wordDuration
              );

        const highlightedText = words
          .map((word, index) =>
            index === activeIndex
              ? `{\\1c${secondaryColor}}${word}{\\1c${primaryColor}}`
              : word
          )
          .join(' ');

        return `Dialogue: 0,${formatAssTime(
          start
        )},${formatAssTime(
          end
        )},Default,,0,0,0,,${regionOverride}${highlightedText}`;
      });
    })
    .join('\n');

  const safeCredit = creditText
    .replace(/\\/g, '')
    .replace(/\{|\}/g, '')
    .replace(/\r?\n/g, ' ')
    .trim();

  const creditEvent = safeCredit
    ? `Dialogue: 1,0:00:00.00,9:59:59.00,Default,,0,0,0,,{\\an7\\fs${Math.max(
        18,
        Math.round(scaledFontSize * 0.55)
      )}\\bord2\\shad1\\1c&HFFFFFF&\\3c&H000000&\\pos(${Math.round(
        width * 0.035
      )},${Math.round(
        height * 0.04
      )})}Source: ${safeCredit}`
    : '';

  const events = [subtitleEvents, creditEvent]
    .filter(Boolean)
    .join('\n');

  fs.writeFileSync(
    filePath,
    `${header}${events}\n`,
    'utf-8'
  );
}


function writeTextOverlayPng(params: {
  filePath: string;
  width: number;
  height: number;
  text: string;
  style: SubtitleStyle;
  credit?: boolean;
  highlightWordIndex?: number;
}): void {
  const {
    filePath,
    width,
    height,
    text,
    style,
    credit = false,
    highlightWordIndex,
  } = params;

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  const fontSize = credit
    ? Math.max(20, Math.round(width * 0.025))
    : Math.max(
        28,
        Math.round(
          (style.fontSize || 22) * (width / 420)
        )
      );

  context.font = `700 ${fontSize}px sans-serif`;

  context.textAlign =
    credit || style.alignment === 'left'
      ? 'left'
      : style.alignment === 'right'
      ? 'right'
      : 'center';

  context.textBaseline = 'middle';

  const region =
    style.region ??
    {
      x: 8,
      y:
        style.position === 'top'
          ? 6
          : style.position === 'center'
          ? 40
          : 72,
      width: 84,
      height: 20,
    };

  const maxWidth = credit
    ? width * 0.88
    : width * (region.width / 100) * 0.92;

  const words = text.trim().split(/\s+/);
  const lines: Array<Array<{ text: string; index: number }>> = [];
  let currentLine: Array<{ text: string; index: number }> = [];

  words.forEach((word, index) => {
    const candidate = [...currentLine, { text: word, index }];
    const candidateText = candidate.map((item) => item.text).join(' ');

    if (
      context.measureText(candidateText).width >
        maxWidth &&
      currentLine.length
    ) {
      lines.push(currentLine);
      currentLine = [{ text: word, index }];
    } else {
      currentLine = candidate;
    }
  });

  if (currentLine.length) {
    lines.push(currentLine);
  }

  const visibleLines = credit
    ? lines.slice(0, 1)
    : lines.slice(0, 3);

  const lineHeight = fontSize * 1.2;

  const blockHeight = credit
    ? visibleLines.length * lineHeight +
      fontSize * 0.65
    : Math.min(
        height * (region.height / 100),
        visibleLines.length * lineHeight +
          fontSize * 0.65
      );

  const centerY = credit
    ? height * 0.055
    : height *
      ((region.y + region.height / 2) / 100);

  const anchorX =
    credit || style.alignment === 'left'
      ? width * 0.06
      : style.alignment === 'right'
      ? width * 0.94
      : width / 2;

  if (style.backgroundBox || credit) {
    context.fillStyle = 'rgba(0,0,0,0.70)';

    context.fillRect(
      credit
        ? width * 0.04
        : width * (region.x / 100),
      centerY - blockHeight / 2,
      credit
        ? width * 0.92
        : width * (region.width / 100),
      blockHeight
    );
  }

  context.lineJoin = 'round';
  context.lineWidth = Math.max(
    3,
    Math.round(fontSize * 0.12)
  );
  context.strokeStyle = '#000000';
  context.textAlign = 'left';

  visibleLines.forEach((line, lineIndex) => {
    const y =
      centerY +
      (lineIndex - (visibleLines.length - 1) / 2) *
        lineHeight;

    const lineText = line.map((item) => item.text).join(' ');
    const lineWidth = context.measureText(
      lineText
    ).width;

    let x =
      credit || style.alignment === 'left'
        ? anchorX
        : style.alignment === 'right'
        ? anchorX - lineWidth
        : anchorX - lineWidth / 2;

    line.forEach((item, wordPosition) => {
      const rendered = `${item.text}${wordPosition < line.length - 1 ? ' ' : ''}`;
      context.strokeText(rendered, x, y);
      context.fillStyle = credit
        ? '#FFFFFF'
        : item.index === highlightWordIndex
        ? style.highlightColor
        : style.textColor;
      context.fillText(rendered, x, y);
      x += context.measureText(rendered).width;
    });
  });

  fs.writeFileSync(
    filePath,
    canvas.toBuffer('image/png')
  );
}


async function createCanvasSubtitleTrack(params: {
  clipId: number;
  stamp: number;
  width: number;
  height: number;
  duration: number;
  segments: TranscriptSegment[];
  style: SubtitleStyle;
}): Promise<{ trackPath: string; temporaryPaths: string[] }> {
  const { clipId, stamp, width, height, duration, segments, style } = params;
  const temporaryPaths: string[] = [];
  const blankPath = path.join(CLIPS_DIR, `clip-${clipId}-${stamp}-sub-blank.png`);
  const blankCanvas = createCanvas(width, height);
  fs.writeFileSync(blankPath, blankCanvas.toBuffer('image/png'));
  temporaryPaths.push(blankPath);

  const entries: Array<{ filePath: string; duration: number }> = [];
  let cursor = 0;

  segments.forEach((segment, segmentIndex) => {
    if (segment.start > cursor + 0.001) {
      entries.push({ filePath: blankPath, duration: segment.start - cursor });
    }

    const words = segment.text.trim().split(/\s+/).filter(Boolean);
    const wordDuration = Math.max(0.04, (segment.end - segment.start) / Math.max(1, words.length));
    words.forEach((_, wordIndex) => {
      const imagePath = path.join(
        CLIPS_DIR,
        `clip-${clipId}-${stamp}-sub-${segmentIndex}-${wordIndex}.png`
      );
      writeTextOverlayPng({
        filePath: imagePath,
        width,
        height,
        text: segment.text,
        style,
        highlightWordIndex: wordIndex,
      });
      temporaryPaths.push(imagePath);
      entries.push({ filePath: imagePath, duration: wordDuration });
    });
    cursor = Math.max(cursor, segment.end);
  });

  if (cursor < duration) {
    entries.push({ filePath: blankPath, duration: duration - cursor });
  }
  if (entries.length === 0) {
    entries.push({ filePath: blankPath, duration });
  }

  const concatPath = path.join(CLIPS_DIR, `clip-${clipId}-${stamp}-subtitles.ffconcat`);
  const trackPath = path.join(CLIPS_DIR, `clip-${clipId}-${stamp}-subtitles.mov`);
  const quotePath = (value: string) => value.replace(/'/g, "'\\''");
  const concatLines = ['ffconcat version 1.0'];
  entries.forEach((entry) => {
    concatLines.push(`file '${quotePath(entry.filePath)}'`);
    concatLines.push(`duration ${Math.max(0.04, entry.duration).toFixed(4)}`);
  });
  concatLines.push(`file '${quotePath(entries[entries.length - 1].filePath)}'`);
  fs.writeFileSync(concatPath, `${concatLines.join('\n')}\n`, 'utf8');
  temporaryPaths.push(concatPath, trackPath);

  await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-fps_mode', 'vfr', '-c:v', 'qtrle', '-pix_fmt', 'argb', trackPath,
  ], 5 * 60 * 1000);

  return { trackPath, temporaryPaths };
}


function clamp(
  value: number,
  minimum: number,
  maximum: number
): number {
  return Math.min(
    maximum,
    Math.max(minimum, value)
  );
}


function cropFilter(
  region: ClipComposition['camera']
): string {
  const width = clamp(region.width, 5, 100) / 100;
  const height = clamp(region.height, 5, 100) / 100;
  const x =
    clamp(region.x, 0, 100 - width * 100) / 100;
  const y =
    clamp(region.y, 0, 100 - height * 100) / 100;

  return `crop=iw*${width.toFixed(
    4
  )}:ih*${height.toFixed(4)}:iw*${x.toFixed(
    4
  )}:ih*${y.toFixed(4)}`;
}


function coverFilter(
  width: number,
  height: number
): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
}


function buildCompositionFilter(
  composition: ClipComposition,
  width: number,
  height: number
): string {
  const contentCrop = cropFilter(
    composition.content
  );

  const cameraCrop = cropFilter(
    composition.camera
  );

  if (!composition.cameraEnabled) {
    return `${contentCrop},${coverFilter(
      width,
      height
    )}`;
  }

  if (composition.layout === 'stacked') {
    const cameraHeight = Math.round(
      height *
        clamp(composition.cameraScale, 20, 60) /
        100
    );

    const contentHeight = height - cameraHeight;
    const topIsCamera =
      composition.cameraPosition === 'top';

    return [
      'split=2[contentSource][cameraSource]',
      `[contentSource]${contentCrop},${coverFilter(
        width,
        contentHeight
      )}[content]`,
      `[cameraSource]${cameraCrop},${coverFilter(
        width,
        cameraHeight
      )}[camera]`,
      topIsCamera
        ? '[camera][content]vstack=inputs=2,setsar=1'
        : '[content][camera]vstack=inputs=2,setsar=1',
    ].join(';');
  }

  if (
    composition.layout === 'picture-in-picture'
  ) {
    const pipWidth = Math.round(
      width *
        clamp(composition.cameraScale, 18, 48) /
        100
    );

    const pipHeight = Math.max(
      2,
      Math.round((pipWidth * 9) / 16 / 2) * 2
    );

    const overlayY =
      composition.cameraPosition === 'top'
        ? Math.round(height * 0.04)
        : `H-h-${Math.round(height * 0.04)}`;

    return [
      'split=2[contentSource][cameraSource]',
      `[contentSource]${contentCrop},${coverFilter(
        width,
        height
      )}[content]`,
      `[cameraSource]${cameraCrop},${coverFilter(
        pipWidth,
        pipHeight
      )}[camera]`,
      `[content][camera]overlay=${Math.round(
        width * 0.04
      )}:${overlayY}:format=auto,setsar=1`,
    ].join(';');
  }

  const region =
    composition.focus === 'camera'
      ? composition.camera
      : composition.content;

  return `${cropFilter(region)},${coverFilter(
    width,
    height
  )}`;
}


function escapeFilterPath(
  filePath: string
): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}


function escapeDrawtextText(
  text: string
): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, ' ');
}


export async function renderClipWithFfmpeg(params: {
  clip: ClipRecord;
  videoPath: string;
  hasAudio: boolean;
  segments: TranscriptSegment[];
  variant?: CompositionVariant;
}): Promise<{
  exportedUrl: string;
  srtUrl: string;
  thumbnailUrl: string | null;
  exportedSizeBytes: number;
}> {
  ensureStorageDirs();

  const {
    clip,
    videoPath,
    hasAudio,
    segments,
    variant,
  } = params;

  const composition = variant
    ? getClipComposition(clip, variant)
    : null;

  const aspectRatio =
    composition?.aspectRatio ?? clip.aspectRatio;

  const { width, height } =
    getTargetDimensions(aspectRatio);

  const clipDuration = Math.max(
    1,
    clip.endTime - clip.startTime
  );

  const stamp = Date.now();
  const variantTag = variant ? `-${variant}` : '';

  const mp4Name = `clip-${clip.id}${variantTag}-${stamp}.mp4`;
  const srtName = `clip-${clip.id}${variantTag}-${stamp}.srt`;
  const assName = `clip-${clip.id}${variantTag}-${stamp}.ass`;
  const thumbName = `clip-${clip.id}${variantTag}-${stamp}.jpg`;

  const mp4Path = path.join(CLIPS_DIR, mp4Name);
  const srtPath = path.join(CLIPS_DIR, srtName);
  const assPath = path.join(CLIPS_DIR, assName);

  const clipSegments = buildClipSegments(
    segments,
    clip.startTime,
    clip.endTime
  );

  writeSrtFile(srtPath, clipSegments);

  const zoom = Math.min(
    2.0,
    Math.max(1.0, clip.zoom || 1.0)
  );

  const cropXRatio = Math.min(
    1,
    Math.max(0, (clip.cropX ?? 50) / 100)
  );

  const cropYRatio = Math.min(
    1,
    Math.max(0, (clip.cropY ?? 50) / 100)
  );

  let videoFilter = '';

  if (composition) {
    videoFilter = buildCompositionFilter(
      composition,
      width,
      height
    );
  } else if (clip.framingMode === 'blur') {
    videoFilter = [
      'split=2[bg][fg]',
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=16:2[bgb]`,
      `[fg]scale=${Math.round(
        width * zoom
      )}:${Math.round(
        height * zoom
      )}:force_original_aspect_ratio=decrease[fgb]`,
      '[bgb][fgb]overlay=(W-w)/2:(H-h)/2,setsar=1',
    ].join(';');
  } else {
    const scaledWidth = Math.round(width * zoom);
    const scaledHeight = Math.round(
      height * zoom
    );

    videoFilter = `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-${width})*${cropXRatio.toFixed(
      3
    )}:(ih-${height})*${cropYRatio.toFixed(
      3
    )},setsar=1`;
  }

  const shouldBurnSubtitles =
    clip.subtitleStyle.enabled &&
    clipSegments.length > 0;

  const shouldBurnCredit = Boolean(
    composition?.creditEnabled &&
      composition.creditText.trim()
  );

  const canBurnAss =
    (shouldBurnSubtitles || shouldBurnCredit) &&
    (await supportsAssFilter());

  const canBurnSubtitles =
    shouldBurnSubtitles &&
    !canBurnAss &&
    (await supportsSubtitlesFilter());

  const canDrawText =
    shouldBurnSubtitles &&
    !canBurnAss &&
    !canBurnSubtitles &&
    (await supportsDrawtextFilter());

  const overlaySpecs: Array<{
    path: string;
    start: number;
    end: number;
  }> = [];
  let canvasSubtitleTrack: string | null = null;
  let canvasSubtitleTemporaryPaths: string[] = [];

  if (canBurnAss) {
    writeAssFile(
      assPath,
      shouldBurnSubtitles ? clipSegments : [],
      clip.subtitleStyle,
      width,
      height,
      composition?.creditEnabled
        ? composition.creditText
        : ''
    );

    const escapedAssPath = escapeFilterPath(
      assPath
    );

    videoFilter = `${videoFilter},ass=filename='${escapedAssPath}'`;
  } else if (canBurnSubtitles) {
    const escapedSrtPath = escapeFilterPath(
      srtPath
    );

    videoFilter = `${videoFilter},subtitles=filename='${escapedSrtPath}'`;
  } else if (canDrawText) {
    const maxSegments = 120;
    const segmentsToBurn = clipSegments.slice(
      0,
      maxSegments
    );

    const drawtextFilters = segmentsToBurn.map(
      (segment) => {
        const safeText = escapeDrawtextText(
          segment.text
        );

        const start = segment.start.toFixed(3);
        const end = segment.end.toFixed(3);

        const fontSize = Math.max(
          28,
          Math.round(
            (clip.subtitleStyle.fontSize || 22) *
              (width / 420)
          )
        );

        const marginV = Math.round(
          height * 0.11
        );

        return [
          `drawtext=text='${safeText}'`,
          `fontsize=${fontSize}`,
          'fontcolor=white',
          'borderw=4',
          'bordercolor=black',
          'box=1',
          'boxcolor=black@0.55',
          'boxborderw=18',
          'x=(w-text_w)/2',
          `y=h-text_h-${marginV}`,
          `enable='between(t,${start},${end})'`,
        ].join(':');
      }
    );

    if (drawtextFilters.length > 0) {
      videoFilter = `${videoFilter},${drawtextFilters.join(
        ','
      )}`;
    }
  } else if (shouldBurnSubtitles) {
    const canvasTrack = await createCanvasSubtitleTrack({
      clipId: clip.id,
      stamp,
      width,
      height,
      duration: clipDuration,
      segments: clipSegments,
      style: clip.subtitleStyle,
    });
    canvasSubtitleTrack = canvasTrack.trackPath;
    canvasSubtitleTemporaryPaths = canvasTrack.temporaryPaths;
  }

  if (
    shouldBurnCredit &&
    composition &&
    !canBurnAss
  ) {
    const creditOverlayPath = path.join(
      CLIPS_DIR,
      `clip-${clip.id}-${stamp}-credit.png`
    );

    writeTextOverlayPng({
      filePath: creditOverlayPath,
      width,
      height,
      text: `Fuente: ${composition.creditText}`,
      style: clip.subtitleStyle,
      credit: true,
    });

    overlaySpecs.push({
      path: creditOverlayPath,
      start: 0,
      end: clipDuration,
    });
  }

  const args: string[] = [
    '-y',
    '-ss',
    clip.startTime.toFixed(2),
    '-t',
    clipDuration.toFixed(2),
    '-i',
    videoPath,
  ];

  if (canvasSubtitleTrack) {
    args.push('-i', canvasSubtitleTrack);
  }

  if (overlaySpecs.length > 0) {
    for (const overlay of overlaySpecs) {
      args.push(
        '-loop',
        '1',
        '-i',
        overlay.path
      );
    }

    const chains: string[] = [
      `${videoFilter}[composition]`,
    ];

    let previousLabel = 'composition';
    let nextInputIndex = 1;

    if (canvasSubtitleTrack) {
      chains.push(
        `[${previousLabel}][${nextInputIndex}:v]overlay=0:0:eof_action=pass:shortest=0[subtitleOverlay]`
      );
      previousLabel = 'subtitleOverlay';
      nextInputIndex++;
    }

    overlaySpecs.forEach((overlay, index) => {
      const outputLabel = `overlay${index}`;

      chains.push(
        `[${previousLabel}][${
          nextInputIndex + index
        }:v]overlay=0:0:shortest=1:enable='between(t,${overlay.start.toFixed(
          3
        )},${overlay.end.toFixed(3)})'[${outputLabel}]`
      );

      previousLabel = outputLabel;
    });

    args.push(
      '-filter_complex',
      chains.join(';'),
      '-map',
      `[${previousLabel}]`
    );

    if (hasAudio) {
      args.push('-map', '0:a?');
    }
  } else if (canvasSubtitleTrack) {
    args.push(
      '-filter_complex',
      `${videoFilter}[composition];[composition][1:v]overlay=0:0:eof_action=pass:shortest=0[subtitleOverlay]`,
      '-map',
      '[subtitleOverlay]'
    );
    if (hasAudio) {
      args.push('-map', '0:a?');
    }
  } else {
    args.push('-vf', videoFilter);
  }

  const useVideoToolbox =
    process.platform === 'darwin' &&
    process.env.CLIPFORGE_HARDWARE_ENCODING === '1' &&
    (await supportsVideoToolboxEncoder());

  args.push('-r', '30');

  if (useVideoToolbox) {
    args.push(
      '-c:v',
      'h264_videotoolbox',
      '-allow_sw',
      '1',
      '-realtime',
      'true',
      '-b:v',
      aspectRatio === '9:16' ? '4500k' : '5500k'
    );
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '24'
    );
  }

  args.push(
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-t',
    clipDuration.toFixed(2)
  );

  if (hasAudio) {
    args.push(
      '-c:a',
      'aac',
      '-b:a',
      '128k'
    );
  } else {
    args.push('-an');
  }

  if (overlaySpecs.length > 0 || canvasSubtitleTrack) {
    args.push('-shortest');
  }

  args.push(mp4Path);

  const subtitleMode = canBurnAss
    ? 'ASS'
    : canBurnSubtitles
    ? 'SRT'
    : canDrawText
    ? 'DRAWTEXT'
    : shouldBurnSubtitles
    ? 'CANVAS'
    : 'NO_SUBTITLES';

  console.log(
    `[ClipForge] Rendering clip ${clip.id} | subtitles: ${subtitleMode} | encoder: ${
      useVideoToolbox ? 'h264_videotoolbox' : 'libx264'
    }`
  );

  try {
    await runFfmpeg(args, 10 * 60 * 1000);
  } catch (error) {
    safeDeleteFile(mp4Path);
    throw error;
  } finally {
    if (fs.existsSync(assPath)) {
      fs.unlinkSync(assPath);
    }

    for (const overlay of overlaySpecs) {
      if (fs.existsSync(overlay.path)) {
        fs.unlinkSync(overlay.path);
      }
    }
    for (const temporaryPath of canvasSubtitleTemporaryPaths) {
      safeDeleteFile(temporaryPath);
    }
  }

  const stat = fs.statSync(mp4Path);

  if (stat.size <= 0) {
    safeDeleteFile(mp4Path);
    throw new Error(
      'FFmpeg generated an empty MP4 clip.'
    );
  }

  const thumbnailUrl = await generateThumbnail(
    mp4Path,
    thumbName,
    Math.min(1.5, clipDuration / 2)
  );

  return {
    exportedUrl: `/storage/clips/${mp4Name}`,
    srtUrl: `/storage/clips/${srtName}`,
    thumbnailUrl,
    exportedSizeBytes: stat.size,
  };
}


function safeDeleteFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup; the original render error is more useful.
  }
}
