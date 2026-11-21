import {
  deleteSubtitleText,
  isFirestoreSubtitlesConfigured,
  readSubtitleText,
  saveSubtitleText,
} from '../processing/firestoreSubtitles';

try { process.loadEnvFile?.(); } catch { /* host-provided environment */ }

if (!isFirestoreSubtitlesConfigured()) {
  throw new Error('Complete FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env.');
}

const documentId = `clip-999999-horizontal`;
const expected = '1\n00:00:00,000 --> 00:00:02,000\nClipForge Firestore diagnostic.\n';
try {
  await saveSubtitleText({
    documentId,
    clipId: 999999,
    videoId: 999999,
    variant: 'horizontal',
    language: 'es',
    srtText: expected,
  });
  const actual = await readSubtitleText(documentId);
  if (actual !== expected) throw new Error('Firestore returned different subtitle content.');
  console.log('Firestore subtitle write/read OK.');
} finally {
  if (await deleteSubtitleText(documentId)) console.log('Firestore delete OK. Diagnostic documents removed.');
}
