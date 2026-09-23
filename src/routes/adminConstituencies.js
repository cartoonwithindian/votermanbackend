/**
 * Admin Constituency Routes
 * Administrative CR constituency management.
 * All routes require an ADMIN session.
 */

const express = require('express');
const router = express.Router();
const constituencyController = require('../controllers/constituencyController');
const constituencyService = require('../services/constituencyService');
const masterCandidateMatcher = require('../services/masterCandidateMatcher');
const { normalizeDepartment, normalizeSection } = require('../utils/classList');
const { normalizeYear } = require('../utils/yearNormalizer');
const { csrfProtection } = require('../middleware/csrfProtection');
const { ObjectId } = require('mongodb');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

const resolveElectionId = (raw) => {
  if (isMongoOnly && raw && ObjectId.isValid(String(raw))) return String(raw);
  return parseInt(raw, 10);
};

// POST /api/v1/admin/constituencies - Create a constituency (+ its CR position)
router.post('/', csrfProtection, constituencyController.create.bind(constituencyController));

// POST /api/v1/admin/constituencies/bulk - Create constituencies for multiple classes at once
router.post('/bulk', csrfProtection, async (req, res) => {
  try {
    const { election_id, classes } = req.body;
    if (!election_id || (!isMongoOnly && isNaN(parseInt(election_id)))) {
      return res.status(400).json({ error: 'Bad Request', message: 'election_id is required.' });
    }
    if (!Array.isArray(classes) || classes.length === 0) {
      return res.status(400).json({ error: 'Bad Request', message: 'classes array is required and must not be empty.' });
    }
    const electionService = require('../services/electionService');
    const resolvedElectionId = resolveElectionId(election_id);
    const election = await electionService.findById(resolvedElectionId);
    if (!election) {
      return res.status(404).json({ error: 'Not Found', message: `Election with ID ${election_id} not found` });
    }
    if (election.status !== 'DRAFT' && election.status !== 'SCHEDULED') {
      return res.status(403).json({ error: 'Forbidden', message: 'Cannot create constituencies when election is OPEN or CLOSED' });
    }
    const created = [];
    const skipped = [];
    const matched = [];
    for (const cls of classes) {
      const department = normalizeDepartment(cls.department);
      const year = normalizeYear(cls.year) || String(cls.year || '').trim();
      const section = normalizeSection(cls.section);
      if (!department || !year) {
        skipped.push({ department: cls.department, year: cls.year, section, reason: 'missing department or year' });
        continue;
      }
      const existing = await constituencyService.findMatching({
        electionId: resolvedElectionId, department, year, section, activeOnly: false,
      });
      if (existing) {
        skipped.push({ department, year, section, reason: 'already exists' });
        continue;
      }
      try {
        const c = await constituencyService.create({
          electionId: resolvedElectionId, department, year, section,
        });
        created.push(c);
        // Auto-match master candidates for this class onto its CR seats.
        try {
          const outcome = await masterCandidateMatcher.matchClassForElection(
            resolvedElectionId,
            { department, year, section }
          );
          if (outcome.placed && outcome.placed.length) {
            matched.push({
              department, year, section,
              placed: outcome.placed.map(p => ({ id: p.id, name: p.name, position_name: p.position_name })),
            });
          }
        } catch (err) {
          console.warn('bulk create: master auto-match failed', { department, year, code: err.code || err.message });
        }
      } catch (err) {
        skipped.push({ department, year, section, reason: err.message });
      }
    }
    return res.status(201).json({ data: { created, skipped, matched, total: created.length + skipped.length } });
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