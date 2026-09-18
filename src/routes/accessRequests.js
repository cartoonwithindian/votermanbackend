/**
 * Access Request — PUBLIC routes (no authentication)
 *
 * POST /api/v1/access-requests          submit a request
 * GET  /api/v1/access-requests/status?collegeEmail=&accessibleEmail=
 *
 * Duplicate handling (spec §8) returns friendly, specific errors.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const service = require('../services/accessRequestService');

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.ACCESS_REQ_SUBMIT_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } },
});

const statusLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } },
});

// ---- POST / ----
router.post('/', submitLimiter, async (req, res) => {
  try {
    const { errors, data } = service.validatePayload(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: errors.join(' ') } });
    }

    const result = await service.submitRequest(data, req.ip);

    if (!result.ok) {
      switch (result.code) {
        case 'PENDING_EXISTS':
          return res.status(409).json({
            error: { code: 'PENDING_EXISTS', message: 'You already have a pending access request. Please wait for administrator approval.' },
          });
        case 'ALREADY_AUTHORIZED':
          return res.status(409).json({
            error: { code: 'ALREADY_AUTHORIZED', message: 'This current email is already registered to your account. Please sign in instead of submitting a request.' },
          });
        case 'EMAIL_EXISTS':
          return res.status(409).json({
            error: { code: 'EMAIL_EXISTS', message: 'One of these emails is already registered in the voting system. Please sign in with Google.' },
          });
        default:
          return res.status(400).json({ error: { code: 'SUBMIT_FAILED', message: 'Could not submit the request.' } });
      }
    }

    return res.status(201).json({
      data: {
        requestId: result.request.id,
        status: 'pending',
        createdAt: result.request.created_at,
        message: 'Your request has been submitted successfully. Please wait for administrator approval.',
      },
    });
  } catch (error) {
    console.error('access request submit failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not submit your request. Please try again later.' } });
  }
});

// ---- GET /status ----
router.get('/status', statusLimiter, async (req, res) => {
  try {
    const { collegeEmail, accessibleEmail } = req.query;
    if (!collegeEmail || !accessibleEmail) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Registered college email and current email are both required.' } });
    }

    const row = await service.checkStatus(collegeEmail, accessibleEmail);

    // Uniform 404 when nothing matches (no request enumeration)
    if (!row) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No access request found for these details.' } });
    }

    let message;
    if (row.status === 'pending') {
      message = 'Your request is currently under review. Please wait for administrator approval.';
    } else if (row.status === 'approved') {
      message = 'Your request has been approved. You can now log in and participate in the election.';
    } else {
      message = 'Your request was not approved.';
    }

    return res.json({
      data: {
        requestId: row.id,
        fullName: row.full_name,
        studentId: row.student_id,
        status: row.status,
        message,
        rejectionReason: row.status === 'rejected' ? row.rejection_reason : undefined,
        createdAt: row.created_at,
        reviewedAt: row.reviewed_at,
      },
    });
  } catch (error) {
    console.error('access request status failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not check the request status.' } });
  }
});

module.exports = router;
