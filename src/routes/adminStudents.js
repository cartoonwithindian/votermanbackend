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

// PATCH /api/v1/admin/students/:id - Update student (admin only)
router.patch('/:id', requireAdmin, csrfProtection, studentController.update.bind(studentController));

// PATCH /api/v1/admin/students/bulk-voting-eligible - Set voting eligibility for all students
router.patch('/bulk-voting-eligible', requireAdmin, csrfProtection, studentController.bulkSetVotingEligible.bind(studentController));

// PATCH /api/v1/admin/students/:id/status - Update student status (admin only)
router.patch('/:id/status', requireAdmin, csrfProtection, studentController.updateStatus.bind(studentController));

module.exports = router;
