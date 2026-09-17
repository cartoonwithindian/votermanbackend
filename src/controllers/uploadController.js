/**
 * Photo Upload Controller — Education Pack
 *
 * POST /api/v1/uploads/photo          — candidate photos (folder "candidates/")
 * POST /api/v1/uploads/profile        — user profile avatars (folder "profiles/")
 * Both land in same Appwrite bucket "candidate-photos" (now
 * "Profile Images & Candidate Photos") to stay within tier-0 1-bucket limit.
 * Education pack bucket: 5 MB, zstd, antivirus, transformations.
 * Postgres keeps only the returned URL.
 */

const photoUploadService = require('../services/photoUploadService');
const studentService = require('../services/studentService');

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=\r\n]+)$/;

async function uploadPhoto(req, res, next) {
  try {
    const { image, folder } = req.body || {};
    if (typeof image !== 'string' || !image) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Request body must include an `image` data-URL string.',
        code: 'INVALID_PHOTO',
      });
    }
    const match = image.match(DATA_URL_RE);
    if (!match) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Image must be a JPEG, PNG, WebP, HEIC or HEIF data-URL.',
        code: 'INVALID_PHOTO',
      });
    }
    const [, mimeType, base64] = match;
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (e) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Photo data is corrupt.',
        code: 'INVALID_PHOTO',
      });
    }
    const requestedFolder = folder === 'profiles' ? 'profiles' : 'candidates';
    const result = await photoUploadService.uploadPhoto(buffer, mimeType, req.user.studentId, { folder: requestedFolder });
    return res.status(201).json({ data: result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.status >= 500 ? 'Internal Server Error' : 'Bad Request',
        message: err.message,
        code: err.code || 'UPLOAD_FAILED',
      });
    }
    return next(err);
  }
}

async function uploadProfile(req, res, next) {
  try {
    const { image } = req.body || {};
    if (typeof image !== 'string' || !image) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Request body must include an `image` data-URL string.',
        code: 'INVALID_PHOTO',
      });
    }
    const match = image.match(DATA_URL_RE);
    if (!match) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Image must be a JPEG, PNG, WebP, HEIC or HEIF data-URL.',
        code: 'INVALID_PHOTO',
      });
    }
    const [, mimeType, base64] = match;
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (e) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Photo data is corrupt.',
        code: 'INVALID_PHOTO',
      });
    }
    const result = await photoUploadService.uploadProfileImage(buffer, mimeType, req.user.studentId);
    // Persist to students.profile_image_url so GET /students/profile returns it
    try {
      await studentService.updateProfileImage(req.user.studentId, result.url);
    } catch (e) {
      // Upload succeeded even if DB persist fails — still return URL so frontend can show it
      console.warn('uploadProfile: failed to persist profile_image_url', e.message);
    }
    return res.status(201).json({ data: result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.status >= 500 ? 'Internal Server Error' : 'Bad Request',
        message: err.message,
        code: err.code || 'UPLOAD_FAILED',
      });
    }
    return next(err);
  }
}

module.exports = {
  uploadPhoto,
  uploadProfile,
};
