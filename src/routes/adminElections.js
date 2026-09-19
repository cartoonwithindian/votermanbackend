/**
 * Admin Election Routes
 * Administrative operations for election management
 * All routes require admin authentication
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const electionController = require('../controllers/electionController');
const { requireAdmin } = require('../middleware/requireAdmin');
const { csrfProtection } = require('../middleware/csrfProtection');

// GET /api/v1/admin/elections - List all elections (admin only)
router.get('/', requireAdmin, electionController.list.bind(electionController));

// POST /api/v1/admin/elections - Create election (admin only)
router.post('/', requireAdmin, csrfProtection, electionController.create.bind(electionController));

// PATCH /api/v1/admin/elections/:id - Update election (admin only)
router.patch('/:id', requireAdmin, csrfProtection, electionController.update.bind(electionController));

// PATCH /api/v1/admin/elections/:id/status - Update election status (admin only)
router.patch('/:id/status', requireAdmin, csrfProtection, electionController.updateStatus.bind(electionController));

// GET /api/v1/admin/elections/:id/readiness - Check election readiness (admin only)
router.get('/:id/readiness', requireAdmin, electionController.getReadiness.bind(electionController));

// POST /api/v1/admin/elections/:id/publish - Publish election results (admin only)
router.post('/:id/publish', requireAdmin, csrfProtection, electionController.publishResults.bind(electionController));

// GET /api/v1/admin/elections/:id/turnout - Per-class voter turnout (admin only)
// For each class (department / year / section): authorized students, how many
// voted, how many are still pending, and the list of pending (not-yet-voted)
// students so admins can chase an election's lagging classes.
router.get('/:id/turnout', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid election id.' } });
    }

    const election = await db.query(
      'SELECT id, name, status FROM elections WHERE id = $1',
      [id]
    );
    if (election.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Election not found.' } });
    }

    const classes = await db.query(
      `SELECT
         COALESCE(NULLIF(s.department, ''), 'Unassigned') AS department,
         COALESCE(NULLIF(s.year_or_semester, ''), '-') AS year,
         COALESCE(NULLIF(s.section, ''), '-') AS section,
         COUNT(*)::int AS total_authorized,
         COUNT(*) FILTER (WHERE v.student_id IS NOT NULL)::int AS voted,
         COUNT(*) FILTER (WHERE v.student_id IS NULL)::int AS pending
       FROM voter_authorizations va
       JOIN students s ON s.id = va.student_id
       LEFT JOIN (SELECT DISTINCT student_id, election_id FROM votes) v
         ON v.student_id = s.id AND v.election_id = va.election_id
       WHERE va.election_id = $1 AND va.is_authorized = true AND s.is_active = true
       GROUP BY 1, 2, 3
       ORDER BY department, year, section`,
      [id]
    );

    const pendingVoters = await db.query(
      `SELECT
         s.id,
         s.student_id,
         s.name,
         s.roll_number,
         COALESCE(NULLIF(s.department, ''), 'Unassigned') AS department,
         COALESCE(NULLIF(s.year_or_semester, ''), '-') AS year,
         COALESCE(NULLIF(s.section, ''), '-') AS section
       FROM voter_authorizations va
       JOIN students s ON s.id = va.student_id
       LEFT JOIN (SELECT DISTINCT student_id, election_id FROM votes) v
         ON v.student_id = s.id AND v.election_id = va.election_id
       WHERE va.election_id = $1 AND va.is_authorized = true AND s.is_active = true
         AND v.student_id IS NULL
       ORDER BY department, year, section, s.name`,
      [id]
    );

    const totalAuthorized = classes.rows.reduce((sum, c) => sum + c.total_authorized, 0);
    const totalVoted = classes.rows.reduce((sum, c) => sum + c.voted, 0);

    const classesWithVoters = classes.rows.map((c) => ({
      ...c,
      participation_pct: c.total_authorized > 0 ? Math.round((c.voted / c.total_authorized) * 1000) / 10 : 0,
      pending_voters: pendingVoters.rows
        .filter((p) => p.department === c.department && p.year === c.year && p.section === c.section)
        .map(({ id: studentId, student_id, name, roll_number }) => ({ studentId, student_id, name, roll_number })),
    }));

    return res.json({
      data: {
        election: election.rows[0],
        totals: {
          total_authorized: totalAuthorized,
          total_voted: totalVoted,
          total_pending: totalAuthorized - totalVoted,
          participation_pct: totalAuthorized > 0 ? Math.round((totalVoted / totalAuthorized) * 1000) / 10 : 0,
        },
        classes: classesWithVoters,
      },
    });
  } catch (error) {
    console.error('admin election turnout failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load voter turnout.' } });
  }
});

module.exports = router;
