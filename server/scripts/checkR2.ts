import {
  buildReadableObjectUrl,
  deleteObjectStorageKey,
  isObjectStorageConfigured,
  uploadLocalFileToObjectStorage,
} from '../processing/objectStorage';

try {
  process.loadEnvFile?.();
} catch {
  // The hosting environment may provide variables without a local .env file.
}

if (!isObjectStorageConfigured()) {
  throw new Error(
    'R2 is not configured. Complete S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in .env.'
  );
}

const key = `diagnostics/clipforge-${Date.now()}.json`;
let uploaded = false;

try {
  await uploadLocalFileToObjectStorage({
    filePath: 'package.json',
    key,
    contentType: 'application/json',
  });
  uploaded = true;
  const response = await fetch(buildReadableObjectUrl(key));
  if (!response.ok) {
    throw new Error(`R2 read failed (${response.status} ${response.statusText}).`);
  }
  const bytes = (await response.arrayBuffer()).byteLength;
  console.log(`R2 write/read OK (${bytes} bytes).`);
} finally {
  if (uploaded) {
    const removed = await deleteObjectStorageKey(key);
    if (!removed) throw new Error('R2 diagnostic object could not be deleted.');
    console.log('R2 delete OK. Diagnostic object removed.');
  }
}
