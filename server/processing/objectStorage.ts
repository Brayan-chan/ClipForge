import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

function getConfig(): ObjectStorageConfig {
  return {
    endpoint: (process.env.S3_ENDPOINT ?? '').trim().replace(/\/+$/, ''),
    region: (process.env.S3_REGION ?? 'auto').trim() || 'auto',
    bucket: (process.env.S3_BUCKET ?? '').trim(),
    accessKeyId: (process.env.S3_ACCESS_KEY_ID ?? '').trim(),
    secretAccessKey: (process.env.S3_SECRET_ACCESS_KEY ?? '').trim(),
    publicBaseUrl: (process.env.S3_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, ''),
  };
}

function s3Client(): { client: S3Client; bucket: string } {
  const cfg = getConfig();
  if (!isObjectStorageConfigured()) throw new Error('Object storage (S3/R2) is not configured.');
  return {
    bucket: cfg.bucket,
    client: new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    }),
  };
}

export function isObjectStorageConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

export function createPresignedObjectUrl(params: {
  method: 'PUT' | 'GET' | 'HEAD' | 'DELETE';
  key: string;
  contentType?: string;
  expiresInSeconds?: number;
}): string {
  const cfg = getConfig();
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('Object storage (S3/R2) is not configured on the server.');
  }

  const parsedEndpoint = new URL(cfg.endpoint);
  const host = parsedEndpoint.host;
  const basePath = parsedEndpoint.pathname.replace(/\/+$/, '');
  const cleanKey = params.key.replace(/^\/+/, '');
  const encodedKeyPath = cleanKey.split('/').map(encodeRfc3986).join('/');
  const canonicalUri = `${basePath}/${encodeRfc3986(cfg.bucket)}/${encodedKeyPath}`;

  const now = new Date();
  const isoBasic = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = isoBasic.slice(0, 8);
  const expires = Math.max(60, Math.min(604800, params.expiresInSeconds ?? 3600));
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;

  const signedHeaderMap: Record<string, string> = { host };
  if (params.method === 'PUT' && params.contentType) {
    signedHeaderMap['content-type'] = params.contentType;
  }
  const signedHeaderNames = Object.keys(signedHeaderMap).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${signedHeaderMap[name]}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': isoBasic,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
  };

  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k])}`)
    .join('&');

  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    isoBasic,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, cfg.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return `${parsedEndpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function buildReadableObjectUrl(key: string): string {
  const cfg = getConfig();
  const cleanKey = key.replace(/^\/+/, '');
  if (cfg.publicBaseUrl) {
    const encodedKeyPath = cleanKey.split('/').map(encodeRfc3986).join('/');
    return `${cfg.publicBaseUrl}/${encodedKeyPath}`;
  }
  return createPresignedObjectUrl({
    method: 'GET',
    key: cleanKey,
    expiresInSeconds: 86400, // 24 hours for FFprobe + FFmpeg Audio-First streaming
  });
}

export function buildMediaProxyUrl(key: string): string {
  const cleanKey = key.replace(/^\/+/, '');
  return `/api/media/${cleanKey.split('/').map(encodeRfc3986).join('/')}`;
}

export function objectKeyFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('r2://')) return value.slice(5).replace(/^\/+/, '');
  const marker = '/api/media/';
  const index = value.indexOf(marker);
  if (index >= 0) {
    return value
      .slice(index + marker.length)
      .split('/')
      .map((part) => decodeURIComponent(part))
      .join('/');
  }
  return null;
}

export async function uploadLocalFileToObjectStorage(params: {
  filePath: string;
  key: string;
  contentType: string;
}): Promise<string> {
  const stat = await fs.promises.stat(params.filePath);
  const putUrl = createPresignedObjectUrl({
    method: 'PUT',
    key: params.key,
    contentType: params.contentType,
    expiresInSeconds: 3600,
  });
  const body = fs.createReadStream(params.filePath);
  const response = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': params.contentType,
      'Content-Length': String(stat.size),
    },
    body: body as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`R2 upload failed (${response.status}): ${detail || response.statusText}`);
  }
  return buildMediaProxyUrl(params.key);
}

export async function downloadObjectStorageKeyToTemp(params: {
  key: string;
  extension?: string;
}): Promise<string> {
  const extension = (params.extension ?? path.extname(params.key) ?? '.mp4')
    .replace(/[^.a-z0-9]/gi, '') || '.mp4';
  const tempPath = path.join(os.tmpdir(), `clipforge-r2-${crypto.randomUUID()}${extension}`);
  try {
    const response = await fetch(buildReadableObjectUrl(params.key));
    if (!response.ok || !response.body) {
      throw new Error(`R2 download failed (${response.status} ${response.statusText}).`);
    }
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      fs.createWriteStream(tempPath)
    );
    const stat = await fs.promises.stat(tempPath);
    if (stat.size === 0) throw new Error('R2 returned an empty object.');
    return tempPath;
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function deleteObjectStorageKey(key: string): Promise<boolean> {
  if (!isObjectStorageConfigured()) return false;
  const response = await fetch(createPresignedObjectUrl({
    method: 'DELETE',
    key: key.replace(/^\/+/, ''),
    expiresInSeconds: 300,
  }), { method: 'DELETE' });
  if (response.ok || response.status === 404) return true;
  const detail = (await response.text()).slice(0, 500);
  throw new Error(`R2 delete failed (${response.status}): ${detail || response.statusText}`);
}

export async function deleteObjectStorageKeys(keys: Iterable<string>): Promise<number> {
  const unique = [...new Set([...keys].filter(Boolean))];
  let removed = 0;
  for (const key of unique) {
    if (await deleteObjectStorageKey(key)) removed++;
  }
  return removed;
}

export async function createMultipartObjectUpload(params: {
  key: string;
  contentType: string;
}): Promise<string> {
  const { client, bucket } = s3Client();
  const result = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: params.key,
    ContentType: params.contentType,
  }));
  if (!result.UploadId) throw new Error('R2 did not return a multipart upload ID.');
  return result.UploadId;
}

export async function createMultipartPartUrl(params: {
  key: string;
  uploadId: string;
  partNumber: number;
}): Promise<string> {
  const { client, bucket } = s3Client();
  return getSignedUrl(client, new UploadPartCommand({
    Bucket: bucket,
    Key: params.key,
    UploadId: params.uploadId,
    PartNumber: params.partNumber,
  }), { expiresIn: 3600 });
}

export async function completeMultipartObjectUpload(params: {
  key: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}): Promise<void> {
  const { client, bucket } = s3Client();
  await client.send(new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: params.key,
    UploadId: params.uploadId,
    MultipartUpload: {
      Parts: params.parts
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
    },
  }));
}

export async function abortMultipartObjectUpload(params: {
  key: string;
  uploadId: string;
}): Promise<void> {
  const { client, bucket } = s3Client();
  await client.send(new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: params.key,
    UploadId: params.uploadId,
  }));
}
