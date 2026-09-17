/**
 * Backup Scheduler
 *
 * Starts an interval timer that runs a DB snapshot + retention prune every
 * BACKUP_INTERVAL_HOURS (default 24). Designed for Render's always-on web
 * service: the timer lives inside the API process, no worker needed.
 *
 * Behavior:
 * - No-op unless Appwrite env is configured (logs once).
 * - A failed run logs and retries on the next tick — never crashes the API.
 * - First run is delayed 30s after boot so migrations/health checks settle.
 */

const backupService = require('../services/backupService');

const DEFAULT_INTERVAL_HOURS = 24;
const FIRST_RUN_DELAY_MS = 30 * 1000;

let timer = null;

function intervalHours() {
  const n = parseInt(process.env.BACKUP_INTERVAL_HOURS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_HOURS;
}

function isConfigured() {
  return Boolean(
    process.env.APPWRITE_ENDPOINT &&
      process.env.APPWRITE_PROJECT_ID &&
      process.env.APPWRITE_API_KEY
  );
}

async function runOnce() {
  try {
    const result = await backupService.runBackup();
    const prune = await backupService.pruneBackups();
    console.log(
      `[backup] snapshot uploaded (${result.bytes} bytes, ` +
        `${Object.values(result.rowCounts).reduce((a, b) => a + b, 0)} rows); ` +
        `pruned ${prune.deleted}, kept ${prune.kept}`
    );
  } catch (err) {
    console.error(`[backup] snapshot failed: ${err.message}`);
  }
}

function start() {
  if (timer) return; // already running
  if (!isConfigured()) {
    console.log('[backup] Appwrite env not configured — scheduled backups disabled');
    return;
  }
  const hours = intervalHours();
  console.log(`[backup] scheduled every ${hours}h (first run in ${FIRST_RUN_DELAY_MS / 1000}s)`);
  setTimeout(() => {
    runOnce();
    timer = setInterval(runOnce, hours * 60 * 60 * 1000);
    timer.unref?.();
  }, FIRST_RUN_DELAY_MS).unref?.();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, runOnce };
