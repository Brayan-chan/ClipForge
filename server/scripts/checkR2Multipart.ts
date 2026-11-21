import {
  abortMultipartObjectUpload,
  buildReadableObjectUrl,
  completeMultipartObjectUpload,
  createMultipartObjectUpload,
  createMultipartPartUrl,
  deleteObjectStorageKey,
  downloadObjectStorageKeyToTemp,
  isObjectStorageConfigured,
} from '../processing/objectStorage';
import fs from 'node:fs';

try {
  process.loadEnvFile?.();
} catch {
  // Environment variables may already be supplied by the host.
}

if (!isObjectStorageConfigured()) throw new Error('R2 is not configured.');

const key = `diagnostics/clipforge-multipart-${Date.now()}.bin`;
let uploadId: string | null = null;
let completed = false;

try {
  uploadId = await createMultipartObjectUpload({ key, contentType: 'application/octet-stream' });
  const payloads = [Buffer.alloc(5 * 1024 * 1024, 0x41), Buffer.from('clipforge-multipart-ok')];
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let index = 0; index < payloads.length; index++) {
    const putUrl = await createMultipartPartUrl({ key, uploadId, partNumber: index + 1 });
    const response = await fetch(putUrl, { method: 'PUT', body: payloads[index] });
    if (!response.ok) throw new Error(`Multipart part ${index + 1} failed (${response.status}).`);
    const etag = response.headers.get('etag');
    if (!etag) throw new Error(`Multipart part ${index + 1} returned no ETag.`);
    parts.push({ partNumber: index + 1, etag });
  }
  await completeMultipartObjectUpload({ key, uploadId, parts });
  completed = true;
  const response = await fetch(buildReadableObjectUrl(key));
  if (!response.ok) throw new Error(`Completed object could not be read (${response.status}).`);
  const expected = payloads.reduce((sum, payload) => sum + payload.length, 0);
  const actual = (await response.arrayBuffer()).byteLength;
  if (actual !== expected) throw new Error(`Multipart size mismatch: expected ${expected}, got ${actual}.`);
  const tempPath = await downloadObjectStorageKeyToTemp({ key, extension: '.bin' });
  try {
    const localSize = (await fs.promises.stat(tempPath)).size;
    if (localSize !== expected) throw new Error(`Temporary download size mismatch: expected ${expected}, got ${localSize}.`);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => undefined);
  }
  console.log(`R2 multipart write/read/temp-download OK (${parts.length} parts, ${actual} bytes).`);
} finally {
  if (completed) {
    await deleteObjectStorageKey(key);
    console.log('R2 multipart delete OK. Diagnostic object removed.');
  } else if (uploadId) {
    await abortMultipartObjectUpload({ key, uploadId });
    console.log('Incomplete R2 multipart diagnostic aborted.');
  }
}
