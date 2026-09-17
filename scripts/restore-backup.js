#!/usr/bin/env node
/**
 * Restore a VoteWeb DB snapshot.
 *
 * Usage:
 *   node scripts/restore-backup.js --latest              # newest snapshot from Appwrite
 *   node scripts/restore-backup.js --file-id <fileId>    # specific snapshot from Appwrite
 *   node scripts/restore-backup.js --file path/to/snapshot.json  # local snapshot file
 *
 * Requires DATABASE_URL (target DB) and, for --latest/--file-id, the
 * APPWRITE_* env vars. Data-only restore: schema must already exist (run
 * `npm run migrate` first). Asks for confirmation when TTY; use --yes to skip.
 */

require('dotenv').config();

const backupService = require('../src/services/backupService');

async function resolveSnapshot() {
  const args = process.argv.slice(2);
  const has = (flag) => args.includes(flag);
  const val = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };

  if (has('--file')) {
    const fs = require('fs');
    const path = val('--file');
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  }
  if (has('--file-id')) {
    return backupService.downloadBackup(val('--file-id'));
  }
  if (has('--latest')) {
    const files = await backupService.listBackups();
    if (!files.length) {
      throw new Error('No snapshots found in the backup bucket.');
    }
    console.log(`Using snapshot: ${files[0].name}`);
    return backupService.downloadBackup(files[0].fileId);
  }
  console.error('Nothing to restore. Use --latest, --file-id <id>, or --file <path>.');
  process.exit(1);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const snapshot = await resolveSnapshot();
  const counts = snapshot.row_counts || {};
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Snapshot created: ${snapshot.created_at}`);
  console.log(`Schema version:   migration #${snapshot.max_migration}`);
  console.log(`Rows:             ${totalRows} across ${Object.keys(counts).length} tables`);
  console.log();

  const skipConfirm = process.argv.includes('--yes') || !process.stdin.isTTY;
  if (!skipConfirm) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(
        `This will TRUNCATE the target tables and re-insert ${totalRows} rows. Continue? (yes/no) `,
        resolve
      );
    });
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const restored = await backupService.restoreSnapshot(snapshot);
  const totalRestored = Object.values(restored).reduce((a, b) => a + b, 0);
  console.log();
  console.log(`Restore complete: ${totalRestored} rows across ${Object.keys(restored).length} tables.`);
  for (const [table, n] of Object.entries(restored)) {
    console.log(`  ${table}: ${n}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`Restore failed: ${err.message}`);
  process.exit(1);
});
