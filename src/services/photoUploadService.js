/**
 * Photo Upload Service (Appwrite Storage)
 *
 * Uploads candidate profile photos to the Appwrite Storage bucket
 * `candidate-photos` (public read) and returns a public view URL.
 * Postgres keeps only the URL string in `profile_photo_url` — no more
 * base64 blobs in the database.
 */

const { Client, Storage, ID, Permission, Role } = require('node-appwrite');
const { InputFile } = require('node-appwrite/file');

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Must stay within the bucket's maximum_file_size (2 MB).
const MAX_BYTES = 2 * 1024 * 1024;

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
  return false;
}

/**
 * Upload a photo buffer to Appwrite Storage.
 * @param {Buffer} buffer - Raw image bytes
 * @param {string} mimeType - One of image/jpeg, image/png, image/webp
 * @param {number|string} studentId - Uploader identity (from session, for the filename)
 * @returns {Promise<{url: string, fileId: string}>} - Public view URL + file ID
 */
async function uploadPhoto(buffer, mimeType, studentId) {
  const ext = ALLOWED_TYPES[mimeType];
  if (!ext) {
    const err = new Error('Only JPEG, PNG, and WebP photos are accepted.');
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
    const err = new Error('Photo must be under 2MB.');
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
  const bucketId = process.env.APPWRITE_PHOTOS_BUCKET || 'candidate-photos';
  const file = await storage.createFile(
    bucketId,
    ID.unique(),
    InputFile.fromBuffer(buffer, `photo-${studentId}-${Date.now()}.${ext}`),
    [Permission.read(Role.any())],
  );
  return {
    url: `${endpoint}/storage/buckets/${bucketId}/files/${file.$id}/view?project=${projectId}`,
    fileId: file.$id,
  };
}

module.exports = {
  uploadPhoto,
  MAX_BYTES,
};
