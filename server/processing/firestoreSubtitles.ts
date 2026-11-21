import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const FIRESTORE_CHUNK_CHARS = 450_000;
let adminApp: App | null = null;

function config() {
  return {
    projectId: (process.env.FIREBASE_PROJECT_ID ?? '').trim(),
    clientEmail: (process.env.FIREBASE_CLIENT_EMAIL ?? '').trim(),
    privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim(),
    credentialsPath: (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim(),
  };
}

export function isFirestoreSubtitlesConfigured(): boolean {
  const value = config();
  return Boolean(
    (value.projectId && value.clientEmail && value.privateKey) || value.credentialsPath
  );
}

function firebaseAdminApp(): App {
  if (adminApp) return adminApp;
  const existing = getApps()[0];
  if (existing) {
    adminApp = existing;
    return existing;
  }
  const value = config();
  if (!isFirestoreSubtitlesConfigured()) {
    throw new Error(
      'Firestore is not configured. Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.'
    );
  }
  adminApp = initializeApp({
    credential:
      value.projectId && value.clientEmail && value.privateKey
        ? cert({
            projectId: value.projectId,
            clientEmail: value.clientEmail,
            privateKey: value.privateKey,
          })
        : applicationDefault(),
    projectId: value.projectId || undefined,
  });
  return adminApp;
}

function firestore(): Firestore {
  return getFirestore(firebaseAdminApp());
}

export async function saveSubtitleText(params: {
  documentId: string;
  clipId: number;
  videoId: number;
  variant: 'vertical' | 'horizontal';
  language: string;
  srtText: string;
}): Promise<void> {
  const db = firestore();
  const manifestRef = db.collection('subtitleManifests').doc(params.documentId);
  const previous = await manifestRef.get();
  const previousChunks = Number(previous.data()?.chunkCount ?? 0);
  const chunks =
    params.srtText.match(new RegExp(`[\\s\\S]{1,${FIRESTORE_CHUNK_CHARS}}`, 'g')) ?? [''];
  const batch = db.batch();
  chunks.forEach((text, index) => {
    batch.set(db.collection('subtitleChunks').doc(`${params.documentId}-${index}`), {
      manifestId: params.documentId,
      index,
      text,
    });
  });
  batch.set(manifestRef, {
    clipId: params.clipId,
    videoId: params.videoId,
    variant: params.variant,
    language: params.language,
    chunkCount: chunks.length,
    updatedAt: new Date(),
  });
  for (let index = chunks.length; index < previousChunks; index++) {
    batch.delete(db.collection('subtitleChunks').doc(`${params.documentId}-${index}`));
  }
  await batch.commit();
}

export async function readSubtitleText(documentId: string): Promise<string | null> {
  if (!isFirestoreSubtitlesConfigured()) return null;
  const db = firestore();
  const manifest = await db.collection('subtitleManifests').doc(documentId).get();
  if (!manifest.exists) return null;
  const chunkCount = Number(manifest.data()?.chunkCount ?? 0);
  const snapshots = await Promise.all(
    Array.from({ length: chunkCount }, (_, index) =>
      db.collection('subtitleChunks').doc(`${documentId}-${index}`).get()
    )
  );
  return snapshots
    .map((snapshot, index) => {
      if (!snapshot.exists) throw new Error(`Firestore subtitle chunk ${index} is missing.`);
      return String(snapshot.data()?.text ?? '');
    })
    .join('');
}

export async function deleteSubtitleText(documentId: string): Promise<boolean> {
  if (!isFirestoreSubtitlesConfigured()) return false;
  const db = firestore();
  const manifestRef = db.collection('subtitleManifests').doc(documentId);
  const manifest = await manifestRef.get();
  if (!manifest.exists) return false;
  const chunkCount = Number(manifest.data()?.chunkCount ?? 0);
  const batch = db.batch();
  for (let index = 0; index < chunkCount; index++) {
    batch.delete(db.collection('subtitleChunks').doc(`${documentId}-${index}`));
  }
  batch.delete(manifestRef);
  await batch.commit();
  return true;
}

export function clipSubtitleDocumentId(
  clipId: number,
  variant: 'vertical' | 'horizontal'
): string {
  return `clip-${clipId}-${variant}`;
}
