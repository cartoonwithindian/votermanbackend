/**
 * Photo Upload Service (Appwrite Storage) — Education Pack (150 GB)
 *
 * Project 6a961a3200335ef36ba8 now under GitHub Student Organization (auto-1)
 * after transfer 2026-09-17 — quota 2 GB → 150 GB, buckets unlimited.
 * Two buckets (education allows 2nd bucket, Free was 1):
 *   - `candidate-photos` ("Profile Images & Candidate Photos") : candidate ballot photos, 5 MB
 *   - `profile-images` ("Profile Images") : user profile avatars, 5 MB
 * Previously single-bucket + folders workaround kept Free within 1-bucket limit;
 * now dedicated bucket per concern. Postgres keeps only URL — no blobs.
 */

const { Client, Storage, ID, Permission, Role } = require('node-appwrite');
const { InputFile } = require('node-appwrite/file');

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

// Education pack bucket: 5 MB (was 2 MB). Keep code guard in sync with
// Appwrite bucket maximum_file_size (5242880). Floor at 5 MB.
const MAX_BYTES = 5 * 1024 * 1024;
// Candidate legacy limit for error messaging; kept for reference.
const LEGACY_MAX_BYTES = 2 * 1024 * 1024;

function storageClient() {
  const endpoint = process.env.APPWRITE_ENDPOINT;
  const projectId = process.env.APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;
  if (!endpoint || !projectId || !apiKey) {
    const err = new Error('Photo uploads are not configured.');
    err.status = 503;
    err.code = 'UPLOAD_NOT_CONFIGURED';
    throw err;
  }
  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  return { client, endpoint, projectId };
}

function hasValidMagicBytes(buffer, mimeType) {
  if (buffer.length < 12) return false;
  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimeType === 'image/webp') {
    return (
      buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  // HEIC/HEIF are ISO-BMFF (ftyp) — accept generically; Appwrite antivirus will scan.
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    return buffer.toString('ascii', 4, 8) === 'ftyp';
  }
  return false;
}

/**
 * Upload a photo buffer to Appwrite Storage.
 * @param {Buffer} buffer - Raw image bytes
 * @param {string} mimeType - One of image/jpeg, image/png, image/webp, image/heic, image/heif
 * @param {number|string} studentId - Uploader identity (from session, for the filename)
 * @param {object} opts - { folder: 'candidates' | 'profiles', bucketId?: string }
 * @returns {Promise<{url: string, fileId: string}>} - Public view URL + file ID
 */
async function uploadPhoto(buffer, mimeType, studentId, opts = {}) {
  const ext = ALLOWED_TYPES[mimeType];
  if (!ext) {
    const err = new Error('Only JPEG, PNG, WebP, HEIC and HEIF photos are accepted.');
    err.status = 400;
    err.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw err;
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const err = new Error('Photo data is missing or corrupt.');
    err.status = 400;
    err.code = 'INVALID_PHOTO';
    throw err;
  }
  if (buffer.length > MAX_BYTES) {
    const err = new Error('Photo must be under 5MB (education pack).');
    err.status = 413;
    err.code = 'PHOTO_TOO_LARGE';
    throw err;
  }
  if (!hasValidMagicBytes(buffer, mimeType)) {
    const err = new Error('Photo data does not match its claimed image type.');
    err.status = 400;
    err.code = 'INVALID_PHOTO';
    throw err;
  }

  const { client, endpoint, projectId } = storageClient();
  const storage = new Storage(client);
  const bucketId = opts.bucketId || process.env.APPWRITE_PHOTOS_BUCKET || 'candidate-photos';
  const folder = opts.folder || 'candidates';
  const file = await storage.createFile(
    bucketId,
    ID.unique(),
    InputFile.fromBuffer(buffer, `photo-${studentId}-${Date.now()}.${ext}`),
    [Permission.read(Role.any())],
    folder || undefined,
  );
  const previewQs = folder === 'profiles' ? '&mode=admin' : '';
  return {
    url: `${endpoint}/storage/buckets/${bucketId}/files/${file.$id}/view?project=${projectId}${previewQs}`,
    fileId: file.$id,
    bucketId,
    folder: folder || '',
  };
}

/**
 * Convenience wrapper for user profile avatars.
 * Education pack: dedicated bucket `profile-images` (was single bucket + folder workaround on Free).
 * Falls back to `candidate-photos/profiles/` if dedicated bucket not configured.
 */
async function uploadProfileImage(buffer, mimeType, studentId) {
  const profileBucket = process.env.APPWRITE_PROFILE_BUCKET || 'profile-images';
  const candidateBucket = process.env.APPWRITE_PHOTOS_BUCKET || 'candidate-photos';
  // If profile bucket is distinct (education), use root; if same bucket (legacy), use folder.
  if (profileBucket && profileBucket !== candidateBucket) {
    return uploadPhoto(buffer, mimeType, studentId, { bucketId: profileBucket, folder: '' });
  }
  return uploadPhoto(buffer, mimeType, studentId, { bucketId: profileBucket, folder: 'profiles' });
}

module.exports = {
  uploadPhoto,
  uploadProfileImage,
  MAX_BYTES,
  LEGACY_MAX_BYTES,
};
