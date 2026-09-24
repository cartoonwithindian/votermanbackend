/**
 * Election Routes - READ ONLY
 * Public read access for elections
 */

const express = require('express');
const router = express.Router();
const electionController = require('../controllers/electionController');
const voteController = require('../controllers/voteController');
const { requireAuth } = require('../middleware/requireAuth');

// GET /api/v1/elections - List all elections (public)
router.get('/', electionController.list.bind(electionController));

// GET /api/v1/elections/my-class-candidates - Candidates standing in the
// authenticated student's own class (any election status, read-only).
// Registered before /:id so the id param does not swallow it.
router.get('/my-class-candidates', requireAuth, voteController.getMyClassCandidates.bind(voteController));

// GET /api/v1/elections/:id - Get single election (public)
router.get('/:id', electionController.get.bind(electionController));

// GET /api/v1/elections/:id/results - Get election results (public, respects publication rules)
router.get('/:id/results', electionController.getResults.bind(electionController));

module.exports = router;
