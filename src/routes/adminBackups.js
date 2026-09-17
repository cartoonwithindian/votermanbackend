/**
 * Backup Routes (admin-only)
 *
 * Database snapshot management: run, list, download, prune.
 * Mounted at /api/v1/admin/backups behind requireAdmin.
 */

const express = require('express');
const router = express.Router();
const backupController = require('../controllers/backupController');

router.get('/status', backupController.status);
router.get('/', backupController.list);
router.post('/run', backupController.run);
router.post('/prune', backupController.prune);
router.get('/:fileId', backupController.download);

module.exports = router;
