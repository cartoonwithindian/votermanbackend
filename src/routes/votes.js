/**
 * Vote Routes
 * API endpoints for vote submission
 *
 * SECURITY:
 * - All routes require authentication (requireAuth)
 * - Student identity comes exclusively from req.user (never from request body/params)
 * - Admin routes require requireAdmin
 */

const express = require('express');
const router = express.Router();
const voteController = require('../controllers/voteController');
const { requireAuth } = require('../middleware/requireAuth');
const { csrfProtection } = require('../middleware/csrfProtection');
const { voteLimiter } = require('../middleware/rateLimiter');

// POST /api/v1/elections/:electionId/votes - Submit a vote (authenticated only)
router.post('/:electionId/votes', requireAuth, csrfProtection, voteLimiter, voteController.submitVote.bind(voteController));

// POST /api/v1/elections/:electionId/votes/ballot - Submit an atomic ballot of
// selections for one constituency/election, all-or-nothing (authenticated only).
// Defined BEFORE /:electionId/votes/:id style routes to avoid matching.
router.post('/:electionId/votes/ballot', requireAuth, csrfProtection, voteLimiter, voteController.submitBallot.bind(voteController));

// GET /api/v1/elections/my-class-candidates - Candidates standing in the
// authenticated student's own class (any election status, read-only)
router.get('/my-class-candidates', requireAuth, voteController.getMyClassCandidates.bind(voteController));

// GET /api/v1/elections/:electionId/votes/my-constituency - Student's own CR seat (authenticated only)
router.get('/:electionId/votes/my-constituency', requireAuth, voteController.getMyConstituency.bind(voteController));

// GET /api/v1/elections/:electionId/votes/check - Check if authenticated student has voted
// Student identity comes from session, NOT from query params
router.get('/:electionId/votes/check', requireAuth, voteController.checkVotes.bind(voteController));

// GET /api/v1/elections/:electionId/votes/receipt - Get authenticated student's receipt for election
// Definition order matters: this must come BEFORE /receipt/:voteId handling, and GET-only,
// so it returns the student's own receipt without requiring a voteId param.
router.get('/:electionId/votes/receipt', requireAuth, voteController.getMyElectionReceipt.bind(voteController));

// GET /api/v1/elections/:electionId/votes/receipt/:voteId - Get vote receipt (authenticated, ownership enforced)
router.get('/:electionId/votes/receipt/:voteId', requireAuth, voteController.getReceipt.bind(voteController));

module.exports = router;
