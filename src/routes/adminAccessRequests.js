/**
 * Access Request — ADMIN routes
 *
 * GET    /api/v1/admin/access-requests           list (status filter)
 * GET    /api/v1/admin/access-requests/:id       single request
 * PATCH  /api/v1/admin/access-requests/:id/approve  create/activate student + grant eligibility
 * PATCH  /api/v1/admin/access-requests/:id/reject   reject with mandatory reason
 *
 * Mounted behind requireAdmin in app.js. req.user is the session-loaded
 * admin, so a student can never reach these endpoints, let alone approve
 * their own request. Every action is written to the auth audit log.
 */
const express = require('express');
const router = express.Router();

const service = require('../services/accessRequestService');
const { csrfProtection } = require('../middleware/csrfProtection');

const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

// ---- GET / ----
router.get('/', async (req, res) => {
  if (isMongoOnly) {
    return res.json({ data: { requests: [], counts: {} } });
  }
  try {
    const data = await service.listRequests({
      status: req.query.status,
      limit: req.query.limit,
    });
    return res.json({ data });
  } catch (error) {
    console.error('list access requests failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load requests.' } });
  }
});

// ---- GET /:id ----
router.get('/:id', async (req, res) => {
  if (isMongoOnly) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  }
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid request id.' } });
    }
    const row = await service.getRequest(id);
    if (!row) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
    }
    return res.json({ data: { request: row } });
  } catch (error) {
    console.error('get access request failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load the request.' } });
  }
});

// ---- PATCH /:id/approve ----
router.patch('/:id/approve', csrfProtection, async (req, res) => {
  if (isMongoOnly) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pending request not found (it may already have been reviewed).' } });
  }
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid request id.' } });
    }

    const note = String((req.body && req.body.note) || '').trim().slice(0, 1000);
    const result = await service.approveRequest(id, req.user, note, req.ip);

    if (!result.ok) {
      return res.status(result.status || 400).json({ error: { code: result.code, message: result.message } });
    }

    return res.json({
      data: {
        approved: true,
        requestId: id,
        studentId: result.student.id,
        studentKey: result.student.student_id,
        message: 'Student added to the authorized list and voting eligibility granted.',
      },
    });
  } catch (error) {
    console.error('approve access request failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not approve the request.' } });
  }
});

// ---- PATCH /:id/reject ----
router.patch('/:id/reject', csrfProtection, async (req, res) => {
  if (isMongoOnly) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pending request not found (it may already have been reviewed).' } });
  }
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid request id.' } });
    }

    const reason = String((req.body && req.body.reason) || '');
    const result = await service.rejectRequest(id, req.user, reason, req.ip);

    if (!result.ok) {
      return res.status(result.status || 400).json({ error: { code: result.code, message: result.message } });
    }

    return res.json({ data: { rejected: true, requestId: id } });
  } catch (error) {
    console.error('reject access request failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not reject the request.' } });
  }
});

module.exports = router;
