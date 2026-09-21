/**
 * Admin Constituency Routes
 * Administrative CR constituency management.
 * All routes require an ADMIN session.
 */

const express = require('express');
const router = express.Router();
const constituencyController = require('../controllers/constituencyController');
const constituencyService = require('../services/constituencyService');
const { csrfProtection } = require('../middleware/csrfProtection');

// POST /api/v1/admin/constituencies - Create a constituency (+ its CR position)
router.post('/', csrfProtection, constituencyController.create.bind(constituencyController));

// POST /api/v1/admin/constituencies/bulk - Create constituencies for multiple classes at once
router.post('/bulk', csrfProtection, async (req, res) => {
  try {
    const { election_id, classes } = req.body;
    if (!election_id || isNaN(parseInt(election_id))) {
      return res.status(400).json({ error: 'Bad Request', message: 'election_id is required.' });
    }
    if (!Array.isArray(classes) || classes.length === 0) {
      return res.status(400).json({ error: 'Bad Request', message: 'classes array is required and must not be empty.' });
    }
    const electionService = require('../services/electionService');
    const election = await electionService.findById(parseInt(election_id));
    if (!election) {
      return res.status(404).json({ error: 'Not Found', message: `Election with ID ${election_id} not found` });
    }
    if (election.status !== 'DRAFT' && election.status !== 'SCHEDULED') {
      return res.status(403).json({ error: 'Forbidden', message: 'Cannot create constituencies when election is OPEN or CLOSED' });
    }
    const created = [];
    const skipped = [];
    for (const cls of classes) {
      const { department, year, section = '' } = cls;
      if (!department || !year) {
        skipped.push({ department, year, section, reason: 'missing department or year' });
        continue;
      }
      const existing = await constituencyService.findMatching({
        electionId: parseInt(election_id), department, year, section, activeOnly: false,
      });
      if (existing) {
        skipped.push({ department, year, section, reason: 'already exists' });
        continue;
      }
      try {
        const c = await constituencyService.create({
          electionId: parseInt(election_id), department, year, section,
        });
        created.push(c);
      } catch (err) {
        skipped.push({ department, year, section, reason: err.message });
      }
    }
    return res.status(201).json({ data: { created, skipped, total: created.length + skipped.length } });
  } catch (err) {
    console.error('bulk constituency create failed:', err);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Could not create constituencies.' });
  }
});

// PATCH /api/v1/admin/constituencies/:id - Update name / is_active
router.patch('/:id', csrfProtection, constituencyController.update.bind(constituencyController));

// DELETE /api/v1/admin/constituencies/:id - Deactivate a constituency
router.delete('/:id', csrfProtection, constituencyController.remove.bind(constituencyController));

module.exports = router;