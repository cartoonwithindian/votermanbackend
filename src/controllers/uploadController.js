/**
 * Photo Upload Controller
 *
 * POST /api/v1/uploads/photo — authenticated students upload a profile
 * photo (base64 data-URL, as produced by the candidate apply page) and get
 * back an Appwrite Storage URL to submit as `profilePhotoUrl`.
 */

const photoUploadService = require('../services/photoUploadService');

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/;

async function uploadPhoto(req, res, next) {
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
        message: 'Image must be a JPEG, PNG, or WebP data-URL.',
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
    const result = await photoUploadService.uploadPhoto(buffer, mimeType, req.user.studentId);
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
};
