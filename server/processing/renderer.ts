import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AspectRatio,
  ClipRecord,
  SubtitleStyle,
  TranscriptSegment,
} from '../../src/types';
import { CLIPS_DIR, ensureStorageDirs } from '../db';
import { generateThumbnail } from './videoAnalyzer';

const execFileAsync = promisify(execFile);

function formatSrtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatAssTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function hexToAssBgr(hex: string, alphaHex = '00'): string {
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length !== 6) return `&H${alphaHex}FFFFFF`;
  const r = cleaned.slice(0, 2);
  const g = cleaned.slice(2, 4);
  const b = cleaned.slice(4, 6);
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase();
}

function getTargetDimensions(aspectRatio: AspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case '1:1':
      return { width: 720, height: 720 };
    case '16:9':
      return { width: 1280, height: 720 };
    case '9:16':
    default:
      return { width: 720, height: 1280 };
  }
}

function buildClipSegments(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number
): TranscriptSegment[] {
  return segments
    .filter((seg) => seg.end > clipStart && seg.start < clipEnd)
    .map((seg, idx) => ({
      id: seg.id || `sub-${idx + 1}`,
      start: Math.max(0, seg.start - clipStart),
      end: Math.max(0.4, Math.min(clipEnd - clipStart, seg.end - clipStart)),
      text: seg.text.trim(),
    }))
    .filter((seg) => seg.text.length > 0);
}

function writeSrtFile(filePath: string, clipSegments: TranscriptSegment[]): void {
  const srt = clipSegments
    .map(
      (seg, i) =>
        `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}`
    )
    .join('\n\n');
  fs.writeFileSync(filePath, srt + '\n', 'utf-8');
}

function writeAssFile(
  filePath: string,
  clipSegments: TranscriptSegment[],
  style: SubtitleStyle,
  width: number,
  height: number
): void {
  const scaledFontSize = Math.round((style.fontSize || 22) * (width / 420));
  const primaryColor = hexToAssBgr(style.textColor || '#FFFFFF', '00');
  const secondaryColor = hexToAssBgr(style.highlightColor || '#22C55E', '00');
  const backColor = style.backgroundBox ? '&H66000000' : '&H00000000';
  const outlineColor = '&H00000000';
  const borderStyle = style.backgroundBox ? 3 : 1;
  const outline = style.backgroundBox ? 8 : 3;
  const shadow = style.backgroundBox ? 0 : 2;

  // ASS alignment numpad: 1=BL, 2=BC, 3=BR, 4=ML, 5=MC, 6=MR, 7=TL, 8=TC, 9=TR
  let alignment = 2;
  const colOffset = style.alignment === 'left' ? -1 : style.alignment === 'right' ? 1 : 0;
  if (style.position === 'top') alignment = 8 + colOffset;
  else if (style.position === 'center') alignment = 5 + colOffset;
  else alignment = 2 + colOffset;

  const marginV = style.position === 'center' ? 0 : Math.round(height * 0.11);

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

  const events = clipSegments
    .map((seg) => {
      const cleanText = seg.text
        .replace(/\\/g, '')
        .replace(/\{|\}/g, '')
        .replace(/\r?\n/g, '\\N');
      return `Dialogue: 0,${formatAssTime(seg.start)},${formatAssTime(seg.end)},Default,,0,0,0,,${cleanText}`;
    })
    .join('\n');

  fs.writeFileSync(filePath, header + events + '\n', 'utf-8');
}

export async function renderClipWithFfmpeg(params: {
  clip: ClipRecord;
  videoPath: string;
  hasAudio: boolean;
  segments: TranscriptSegment[];
}): Promise<{
  exportedUrl: string;
  srtUrl: string;
  thumbnailUrl: string | null;
  exportedSizeBytes: number;
}> {
  ensureStorageDirs();
  const { clip, videoPath, hasAudio, segments } = params;
  const { width, height } = getTargetDimensions(clip.aspectRatio);
  const clipDuration = Math.max(1, clip.endTime - clip.startTime);

  const stamp = Date.now();
  const mp4Name = `clip-${clip.id}-${stamp}.mp4`;
  const srtName = `clip-${clip.id}-${stamp}.srt`;
  const assName = `clip-${clip.id}-${stamp}.ass`;
  const thumbName = `clip-${clip.id}-${stamp}.jpg`;

  const mp4Path = path.join(CLIPS_DIR, mp4Name);
  const srtPath = path.join(CLIPS_DIR, srtName);
  const assPath = path.join(CLIPS_DIR, assName);

  const clipSegments = buildClipSegments(segments, clip.startTime, clip.endTime);
  writeSrtFile(srtPath, clipSegments);

  const zoom = Math.min(2.0, Math.max(1.0, clip.zoom || 1.0));
  const cropXRatio = Math.min(1, Math.max(0, (clip.cropX ?? 50) / 100));
  const cropYRatio = Math.min(1, Math.max(0, (clip.cropY ?? 50) / 100));

  let videoFilter = '';
  if (clip.framingMode === 'blur') {
    videoFilter = [
      `split=2[bg][fg]`,
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=16:2[bgb]`,
      `[fg]scale=${Math.round(width * zoom)}:${Math.round(height * zoom)}:force_original_aspect_ratio=decrease[fgb]`,
      `[bgb][fgb]overlay=(W-w)/2:(H-h)/2,setsar=1`,
    ].join(';');
  } else {
    const scaledW = Math.round(width * zoom);
    const scaledH = Math.round(height * zoom);
    videoFilter = `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-${width})*${cropXRatio.toFixed(3)}:(ih-${height})*${cropYRatio.toFixed(3)},setsar=1`;
  }

  if (clip.subtitleStyle.enabled && clipSegments.length > 0) {
    writeAssFile(assPath, clipSegments, clip.subtitleStyle, width, height);
    const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    if (clip.framingMode === 'blur') {
      videoFilter = `${videoFilter},ass='${escapedAss}'`;
    } else {
      videoFilter = `${videoFilter},ass='${escapedAss}'`;
    }
  }

  const args: string[] = [
    '-y',
    '-ss',
    clip.startTime.toFixed(2),
    '-t',
    clipDuration.toFixed(2),
    '-i',
    videoPath,
    '-vf',
    videoFilter,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
  ];

  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }

  args.push(mp4Path);

  await execFileAsync('ffmpeg', args);

  // Clean up temporary .ass file after burn-in
  if (fs.existsSync(assPath)) {
    fs.unlinkSync(assPath);
  }

  const stat = fs.statSync(mp4Path);
  const thumbnailUrl = await generateThumbnail(mp4Path, thumbName, Math.min(1.5, clipDuration / 2));

  return {
    exportedUrl: `/storage/clips/${mp4Name}`,
    srtUrl: `/storage/clips/${srtName}`,
    thumbnailUrl,
    exportedSizeBytes: stat.size,
  };
}
