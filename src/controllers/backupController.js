/**
 * Backup Controller
 *
 * Admin endpoints for database snapshot backups stored in Appwrite Storage.
 * - POST /api/v1/admin/backups/run      — run a snapshot now
 * - GET  /api/v1/admin/backups          — list snapshots
 * - GET  /api/v1/admin/backups/status   — config + latest snapshot info
 * - GET  /api/v1/admin/backups/:fileId  — download a snapshot JSON
 * - POST /api/v1/admin/backups/prune    — enforce retention
 */

const backupService = require('../services/backupService');

function isConfigured() {
  return Boolean(
    process.env.APPWRITE_ENDPOINT &&
      process.env.APPWRITE_PROJECT_ID &&
      process.env.APPWRITE_API_KEY
  );
}

async function status(req, res) {
  const configured = isConfigured();
  let latest = null;
  let total = 0;
  if (configured) {
    try {
      const files = await backupService.listBackups();
      total = files.length;
      latest = files[0] || null;
    } catch {
      // bucket may not exist yet — report configured but empty
    }
  }
  return res.json({
    data: {
      configured,
      bucket: process.env.APPWRITE_BACKUPS_BUCKET || 'db-backups',
      intervalHours: parseInt(process.env.BACKUP_INTERVAL_HOURS, 10) || 24,
      total,
      latest,
    },
  });
}

async function list(req, res) {
  try {
    const files = await backupService.listBackups();
    return res.json({ data: files });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.code || 'BACKUP_ERROR', message: err.message });
    }
    return next(err);
  }
}

async function run(req, res, next) {
  try {
    const result = await backupService.runBackup();
    await backupService.pruneBackups();
    return res.status(201).json({ data: result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.code || 'BACKUP_ERROR', message: err.message });
    }
    return next(err);
  }
}

async function download(req, res, next) {
  try {
    const snapshot = await backupService.downloadBackup(req.params.fileId);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="voteweb-snapshot-${stamp}.json"`
    );
    return res.json(snapshot);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.code || 'BACKUP_ERROR', message: err.message });
    }
    return next(err);
  }
}

async function prune(req, res, next) {
  try {
    const keep = parseInt(req.body?.keep, 10) || backupService.RETENTION_DEFAULT;
    const result = await backupService.pruneBackups(keep);
    return res.json({ data: result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.code || 'BACKUP_ERROR', message: err.message });
    }
    return next(err);
  }
}

module.exports = { status, list, run, download, prune };
