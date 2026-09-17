/**
 * Photo Upload Routes — Education Pack
 *
 * SECURITY:
 * - All routes require authentication (student identity from req.user.studentId)
 * - State-changing POST is CSRF + session-binding protected like other writes
 * - Files land in the Appwrite `candidate-photos` bucket (public read,
 *   now "Profile Images & Candidate Photos" — education pack: 5MB, zstd,
 *   antivirus, transformations). Same bucket, two folders:
 *     candidates/ -> candidate application photos (profile_photo_url)
 *     profiles/   -> user profile avatars (students.profile_image_url)
 *   Single bucket keeps tier-0 within 1-bucket limit; folders provide logical separation.
 */

const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/uploadController');
const { loadSession } = require('../middleware/loadSession');
const { requireAuth } = require('../middleware/requireAuth');
const { csrfProtection } = require('../middleware/csrfProtection');

// All routes require authentication
router.use(loadSession, requireAuth);

// Candidate application photo (folder: candidates/) — used by /api/candidates/apply flow
router.post('/photo', csrfProtection, uploadController.uploadPhoto);

// User profile avatar (folder: profiles/) — persists to students.profile_image_url
router.post('/profile', csrfProtection, uploadController.uploadProfile);

module.exports = router;
