/**
 * Admin Student Routes
 * Administrative operations for student management
 * All routes require admin authentication
 */

const express = require('express');
const router = express.Router();
const studentController = require('../controllers/studentController');
const { requireAdmin } = require('../middleware/requireAdmin');
const { csrfProtection } = require('../middleware/csrfProtection');

// GET /api/v1/admin/students - List all students (admin only)
router.get('/', requireAdmin, studentController.list.bind(studentController));

// POST /api/v1/admin/students - Create student (admin only)
router.post('/', requireAdmin, csrfProtection, studentController.create.bind(studentController));

// PATCH /api/v1/admin/students/bulk-voting-eligible - Set voting eligibility for all students
// NOTE: must be defined BEFORE /:id or Express matches "bulk-voting-eligible" as :id
router.patch('/bulk-voting-eligible', requireAdmin, csrfProtection, studentController.bulkSetVotingEligible.bind(studentController));

// GET /api/v1/admin/students/classes - Get unique department+year+section combinations
router.get('/classes', requireAdmin, async (req, res) => {
  try {
    const db = require('../db');
    const { normalizeYear } = require('../utils/yearNormalizer');
    const result = await db.query(
      `SELECT DISTINCT
         COALESCE(NULLIF(department, ''), 'Unassigned') AS department,
         COALESCE(NULLIF(year_or_semester, ''), '-') AS year_or_semester,
         COALESCE(NULLIF(section, ''), '') AS section,
         COUNT(*)::int AS student_count
       FROM students
       WHERE is_active = true
       GROUP BY 1, 2, 3
       ORDER BY department, year_or_semester, section`
    );
    const classes = result.rows.map(r => ({
      department: r.department,
      year_or_semester: r.year_or_semester,
      year_normalized: normalizeYear(r.year_or_semester),
      section: r.section,
      student_count: r.student_count,
    }));
    return res.json({ data: classes });
  } catch (err) {
    console.error('admin students/classes failed:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load classes.' } });
  }
});

// PATCH /api/v1/admin/students/:id - Update student (admin only)
router.patch('/:id', requireAdmin, csrfProtection, studentController.update.bind(studentController));

// PATCH /api/v1/admin/students/:id/status - Update student status (admin only)
router.patch('/:id/status', requireAdmin, csrfProtection, studentController.updateStatus.bind(studentController));

module.exports = router;
