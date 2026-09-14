/**
 * Photo Upload Routes
 *
 * SECURITY:
 * - All routes require authentication (student identity from req.user.studentId)
 * - State-changing POST is CSRF + session-binding protected like other writes
 * - Files land in the Appwrite `candidate-photos` bucket (public read);
 *   Postgres stores only the returned URL in `profile_photo_url`
 */

const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/uploadController');
const { requireAuth } = require('../middleware/requireAuth');
const { csrfProtection } = require('../middleware/csrfProtection');

// All routes require authentication
router.use(requireAuth);

// Upload a profile photo, returns { data: { url, fileId } }
router.post('/photo', csrfProtection, uploadController.uploadPhoto);

module.exports = router;
