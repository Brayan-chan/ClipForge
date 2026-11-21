import fs from 'node:fs';

function config() {
  return {
    cloudName: (process.env.CLOUDINARY_CLOUD_NAME ?? '').trim(),
    apiKey: (process.env.CLOUDINARY_API_KEY ?? '').trim(),
    apiSecret: (process.env.CLOUDINARY_API_SECRET ?? '').trim(),
  };
}

export function isCloudinaryConfigured(): boolean {
  const value = config();
  return Boolean(value.cloudName && value.apiKey && value.apiSecret);
}

function authHeader(): string {
  const value = config();
  return `Basic ${Buffer.from(`${value.apiKey}:${value.apiSecret}`).toString('base64')}`;
}

export function cloudinaryPublicIdForFilename(filename: string): string {
  return `clipforge/thumbnails/${filename.replace(/\.[^.]+$/, '')}`;
}

export async function uploadThumbnailToCloudinary(filePath: string, filename: string): Promise<{
  url: string;
  publicId: string;
}> {
  if (!isCloudinaryConfigured()) throw new Error('Cloudinary is not configured.');
  const value = config();
  const publicId = cloudinaryPublicIdForFilename(filename);
  const bytes = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), filename);
  form.append('public_id', publicId);
  form.append('overwrite', 'true');
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(value.cloudName)}/image/upload`, {
    method: 'POST',
    headers: { Authorization: authHeader() },
    body: form,
  });
  const body = await response.json() as { secure_url?: string; public_id?: string; error?: { message?: string } };
  if (!response.ok || !body.secure_url) {
    throw new Error(`Cloudinary upload failed: ${body.error?.message ?? response.statusText}`);
  }
  return { url: body.secure_url, publicId: body.public_id ?? publicId };
}

export async function deleteCloudinaryImage(publicId: string): Promise<boolean> {
  if (!isCloudinaryConfigured() || !publicId) return false;
  const value = config();
  const form = new FormData();
  form.append('public_id', publicId);
  form.append('invalidate', 'true');
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(value.cloudName)}/image/destroy`, {
    method: 'POST',
    headers: { Authorization: authHeader() },
    body: form,
  });
  const body = await response.json() as { result?: string; error?: { message?: string } };
  if (!response.ok || !['ok', 'not found'].includes(body.result ?? '')) {
    throw new Error(`Cloudinary delete failed: ${body.error?.message ?? response.statusText}`);
  }
  return body.result === 'ok';
}
