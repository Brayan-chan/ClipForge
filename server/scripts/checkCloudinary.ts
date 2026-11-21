import {
  deleteCloudinaryImage,
  isCloudinaryConfigured,
  uploadThumbnailToCloudinary,
} from '../processing/cloudinaryImages';

try { process.loadEnvFile?.(); } catch { /* host-provided environment */ }

if (!isCloudinaryConfigured()) {
  throw new Error('Complete CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env.');
}

const filename = 'clipforge-diagnostic.png';
const uploaded = await uploadThumbnailToCloudinary(
  'public/assets/aistudio/image_47021c8e.png',
  filename
);
console.log(`Cloudinary upload OK: ${uploaded.url}`);
if (await deleteCloudinaryImage(uploaded.publicId)) {
  console.log('Cloudinary delete OK. Diagnostic image removed.');
}
