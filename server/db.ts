import fs from 'node:fs';
import path from 'node:path';
import type {
  ClipRecord,
  ProcessingJob,
  Project,
  ScoringConfig,
  SubtitleStyle,
  TranscriptionRecord,
  User,
  VideoRecord,
} from '../src/types';

export const STORAGE_ROOT = path.resolve(process.cwd(), 'storage');
export const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
export const CLIPS_DIR = path.join(STORAGE_ROOT, 'clips');
export const THUMBNAILS_DIR = path.join(STORAGE_ROOT, 'thumbnails');
export const TRANSCRIPTS_DIR = path.join(STORAGE_ROOT, 'transcripts');
export const DB_FILE = path.join(STORAGE_ROOT, 'clipforge.db.json');

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  enabled: true,
  preset: 'hormozi',
  fontSize: 22,
  textColor: '#FFFFFF',
  highlightColor: '#22C55E',
  position: 'bottom',
  alignment: 'center',
  backgroundBox: true,
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  hookWeight: 25,
  infoWeight: 25,
  emotionWeight: 20,
  selfContainedWeight: 20,
  durationWeight: 10,
  llmThreshold: 55,
  minClipSeconds: 12,
  maxClipSeconds: 60,
};

export interface DatabaseSchema {
  users: User[];
  projects: Project[];
  videos: VideoRecord[];
  transcriptions: TranscriptionRecord[];
  clips: ClipRecord[];
  processingJobs: ProcessingJob[];
  scoringConfig: ScoringConfig;
  nextIds: {
    user: number;
    project: number;
    video: number;
    transcription: number;
    clip: number;
    job: number;
  };
}

export function ensureStorageDirs(): void {
  for (const dir of [STORAGE_ROOT, UPLOADS_DIR, CLIPS_DIR, THUMBNAILS_DIR, TRANSCRIPTS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function createInitialDb(): DatabaseSchema {
  return {
    users: [
      {
        id: 1,
        email: 'creator@clipforge.local',
        name: 'Studio Creator',
      },
    ],
    projects: [
      {
        id: 1,
        userId: 1,
        name: 'Podcast & Tech Clips MVP',
        description: 'Long-form interviews and builder episodes converted into 9:16 vertical shorts.',
        createdAt: new Date().toISOString(),
      },
    ],
    videos: [],
    transcriptions: [],
    clips: [],
    processingJobs: [],
    scoringConfig: { ...DEFAULT_SCORING_CONFIG },
    nextIds: {
      user: 2,
      project: 2,
      video: 1,
      transcription: 1,
      clip: 1,
      job: 1,
    },
  };
}

let cachedDb: DatabaseSchema | null = null;

export function readDb(): DatabaseSchema {
  ensureStorageDirs();
  if (cachedDb) return cachedDb;
  if (!fs.existsSync(DB_FILE)) {
    const initial = createInitialDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    cachedDb = initial;
    return cachedDb;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as DatabaseSchema;
    if (!parsed.scoringConfig) {
      parsed.scoringConfig = { ...DEFAULT_SCORING_CONFIG };
    }
    cachedDb = parsed;
    return cachedDb;
  } catch {
    const initial = createInitialDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    cachedDb = initial;
    return cachedDb;
  }
}

export function writeDb(db: DatabaseSchema): void {
  ensureStorageDirs();
  cachedDb = db;
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

export function getStorageUsageBytes(): number {
  ensureStorageDirs();
  let total = 0;
  const dirs = [UPLOADS_DIR, CLIPS_DIR, THUMBNAILS_DIR, TRANSCRIPTS_DIR];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) total += stat.size;
      } catch {
        // ignore missing temp files
      }
    }
  }
  return total;
}
