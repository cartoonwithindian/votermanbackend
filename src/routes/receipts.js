/**
 * Receipt Routes
 * Public and private endpoints for vote receipt verification
 */

const express = require('express');
const router = express.Router();
const receiptService = require('../services/receiptService');
const { loadSession } = require('../middleware/loadSession');
const { requireAuth } = require('../middleware/requireAuth');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

/**
 * GET /api/v1/receipts/me/:electionId
 * Private endpoint to get the authenticated student's receipt for an election
 * Requires authentication and enforces ownership
 * Returns FULL receipt details (student info, vote choices, etc.)
 * NOTE: This route MUST be defined BEFORE /:id to avoid /me being matched as :id
 */
router.get('/me/:electionId', loadSession, requireAuth, async (req, res, next) => {
  try {
    const { electionId } = req.params;

    // SECURITY: Get student identity from authenticated session ONLY
    const studentId = req.user?.studentId;
    if (!studentId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required.',
        code: 'AUTH_REQUIRED',
      });
    }

    // In Mongo-only, election ids may be hex/ObjectId strings — pass through
    // untouched. In Postgres they are integers.
    const parsedElectionId = isMongoOnly ? String(electionId || '').trim() : parseInt(electionId, 10);
    if (isMongoOnly ? !parsedElectionId : isNaN(parsedElectionId)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid election ID.',
      });
    }

    // Get full receipt details with ownership enforcement
    const receipt = await receiptService.getFullReceiptDetails(studentId, parsedElectionId);

    if (!receipt) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Receipt not found for this election.',
      });
    }

    // Format the date/time nicely
    const votedAt = new Date(receipt.createdAt);
    const dateStr = votedAt.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const timeStr = votedAt.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    res.json({
      valid: true,
      receipt: {
        // Receipt identifiers
        receiptId: receipt.receiptId,
        receiptHash: receipt.receiptHash,
        // Formatted date/time
        date: dateStr,
        time: timeStr,
        votedAt: receipt.createdAt,
        // Election info
        election: {
          id: receipt.electionId,
          name: receipt.electionName,
          status: receipt.electionStatus,
        },
        // Vote details (what the student voted for)
        vote: {
          position: receipt.positionName,
          candidate: receipt.candidateName,
        },
        // Student info (limited)
        voter: {
          studentId: receipt.studentId,
          name: receipt.studentName,
        },
        // Verification status
        verified: true,
      },
    });

  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/receipts/:id
 * Public endpoint to verify a vote receipt
 * Does not require authentication - receipt ID is the secret
 * Returns ONLY public verification info (no voter identity, no vote choices)
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await receiptService.verifyReceipt(id);

    if (result.error) {
      return res.status(result.valid === false && result.error === 'Receipt not found' ? 404 : 400).json({
        error: 'Bad Request',
        message: result.error,
      });
    }

    res.json({
      valid: result.valid,
      receipt: {
        receiptId: result.receipt?.id,
        receiptHash: result.receipt?.receiptHash,
        electionName: result.receipt?.electionName,
        electionStatus: result.receipt?.electionStatus,
        votedAt: result.receipt?.createdAt,
        // We don't reveal the actual vote choices for privacy
        verified: true,
      },
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
