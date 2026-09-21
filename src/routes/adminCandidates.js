/**
 * Admin Candidate Routes
 * Administrative operations for candidate management
 * All routes require admin authentication
 */

const express = require('express');
const router = express.Router();
const candidateController = require('../controllers/candidateController');
const { requireAdmin } = require('../middleware/requireAdmin');
const { csrfProtection } = require('../middleware/csrfProtection');

// PATCH /api/v1/admin/candidates/:id - Update candidate (admin only)
router.patch('/:id', requireAdmin, csrfProtection, candidateController.update.bind(candidateController));

// JSON override: admin uploads a JSON file, students see JSON (cohort-filtered)
router.post('/json', requireAdmin, csrfProtection, candidateController.uploadJson.bind(candidateController));
router.get('/json', requireAdmin, candidateController.getJson.bind(candidateController));
router.delete('/json', requireAdmin, csrfProtection, candidateController.deleteJson.bind(candidateController));

// Add-to-ballot: materialize uploaded JSON candidates into voteable DB ballot rows
router.post('/json/add-to-ballot', requireAdmin, csrfProtection, candidateController.addToBallot.bind(candidateController));

// Remove a single ballot candidate (must come AFTER /json routes, causes 404 otherwise)
router.delete('/ballot/:id', requireAdmin, csrfProtection, candidateController.removeBallotCandidate.bind(candidateController));

module.exports = router;
