/**
 * Database Backup Service
 *
 * Exports every table's rows to a single JSON snapshot and uploads it to
 * Appwrite Storage (bucket `db-backups`). Protects against Render's free
 * Postgres expiry/wipe: snapshots live off-host and can be restored with
 * `npm run db:restore`.
 *
 * Design notes:
 * - Plain SQL `row_to_json` reads through the existing pg pool — no native
 *   pg_dump binary (unavailable on Render's runtime image), no new deps.
 * - Snapshots include schema version (max migration) + row counts so the
 *   restore path can warn on mismatched schemas.
 * - Restore is data-only (schema must exist via migrations), FK-order-aware
 *   via a topological sort of pg_constraint dependencies.
 * - Retention: keeps the newest N snapshots, deletes older ones.
 * - Never runs concurrently with itself (in-process single-flight lock).
 *
 * LOCAL FALLBACK (100% local): if Appwrite env (ENDPOINT/PROJECT_ID/API_KEY) is
 * not set, snapshots are stored locally under /tmp/voteweb-backups as JSON files.
 * list/download/prune operate on the filesystem instead of Appwrite. Keeps
 * Appwrite path when configured (prod), but local works without any keys.
 */

const { Client, Storage, ID, Permission, Role } = require('node-appwrite');
const { InputFile } = require('node-appwrite/file');
const fs = require('fs');
const path = require('path');

const BACKUP_BUCKET_DEFAULT = 'db-backups';
const LOCAL_BACKUP_DIR = process.env.LOCAL_BACKUP_DIR || '/tmp/voteweb-backups';

/** Tables excluded from snapshots (session/state noise, not user data). */
const EXCLUDED_TABLES = new Set([
  'sessions',
  'mfa_challenges',
  'otp_challenges',
  'migrations',
]);

const RETENTION_DEFAULT = 14;

function isAppwriteConfigured() {
  return Boolean(
    process.env.APPWRITE_ENDPOINT &&
      process.env.APPWRITE_PROJECT_ID &&
      process.env.APPWRITE_API_KEY
  );
}

function ensureBackupDir() {
  if (!fs.existsSync(LOCAL_BACKUP_DIR)) {
    fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
  }
}

function localBaseUrl() {
  const port = process.env.PORT || 3000;
  return process.env.LOCAL_BACKUP_BASE_URL || `http://localhost:${port}`;
}

function backupConfig() {
  const endpoint = process.env.APPWRITE_ENDPOINT;
  const projectId = process.env.APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;
  if (!endpoint || !projectId || !apiKey) {
    const err = new Error('Backup storage is not configured (missing Appwrite env).');
    err.status = 503;
    err.code = 'BACKUP_NOT_CONFIGURED';
    throw err;
  }
  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  return {
    client,
    bucketId: process.env.APPWRITE_BACKUPS_BUCKET || BACKUP_BUCKET_DEFAULT,
  };
}

/**
 * List non-excluded, real tables (base + partitioned) in `public`.
 * @param {import('pg').Pool} pool
 * @returns {Promise<Array<{name: string, columns: string[]}>>}
 */
async function listTables(pool) {
  const { rows } = await pool.query(
    `SELECT c.relname AS name,
            COALESCE(json_agg(a.attname ORDER BY a.attnum) FILTER (WHERE a.attname IS NOT NULL), '[]'::json) AS columns
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname = 'public'
      GROUP BY c.oid, c.relname
      ORDER BY c.relname`
  );
  return rows
    .filter((r) => !EXCLUDED_TABLES.has(r.name))
    .map((r) => ({ name: r.name, columns: r.columns }));
}

/**
 * Read all rows of a table as plain JSON values.
 * @param {import('pg').Pool} pool
 * @param {string} table
 * @param {string[]} columns
 * @returns {Promise<Array<Object>>}
 */
async function readTableRows(pool, table, columns) {
  // identifier-safe: table + column names come from pg_catalog, not user input
  const cols = columns.map((c) => `"${c}"`).join(', ');
  const { rows } = await pool.query(
    `SELECT to_jsonb(t) AS row FROM (SELECT ${cols} FROM "${table}") t`
  );
  return rows.map((r) => r.row);
}

/**
 * Build the snapshot document.
 * @param {import('pg').Pool} pool
 * @returns {Promise<Object>}
 */
async function buildSnapshot(pool) {
  const tables = await listTables(pool);
  const data = {};
  const rowCountByTable = {};
  for (const t of tables) {
    const rows = await readTableRows(pool, t.name, t.columns);
    data[t.name] = rows;
    rowCountByTable[t.name] = rows.length;
  }
  const { rows: migRows } = await pool.query(
    `SELECT COALESCE(MAX(id), 0)::int AS max_migration FROM migrations`
  );
  const maxMigration = migRows[0]?.max_migration ?? 0;
  return {
    format: 'voteweb-db-snapshot',
    version: 1,
    created_at: new Date().toISOString(),
    max_migration: maxMigration,
    row_counts: rowCountByTable,
    tables: data,
  };
}

/**
 * Run a full snapshot + upload. Single-flight: concurrent callers share the
 * same in-progress run.
 * @param {import('pg').Pool} [pool] - optional pool override (tests)
 * @returns {Promise<{fileId: string, url: string, bytes: number, rowCounts: Object, createdAt: string}>}
 */
let inFlight = null;
async function runBackup(pool) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const dbPool = pool || require('../db').pool;
    const snapshot = await buildSnapshot(dbPool);
    const json = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(json, 'utf8');
    const createdAt = snapshot.created_at;

    if (!isAppwriteConfigured()) {
      // Local fallback: store JSON file under /tmp/voteweb-backups
      ensureBackupDir();
      const fileId = ID.unique();
      const fileName = `voteweb-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${fileId}.json`;
      const filePath = path.join(LOCAL_BACKUP_DIR, fileName);
      fs.writeFileSync(filePath, json, 'utf8');
      console.log(`[local-backup] snapshot stored ${filePath} (${bytes} bytes)`);
      return {
        fileId: fileName,
        url: `${localBaseUrl()}/backups/${fileName}`,
        bytes,
        rowCounts: snapshot.row_counts,
        createdAt,
      };
    }

    const { client, bucketId } = backupConfig();
    const storage = new Storage(client);
    const fileName = `voteweb-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const file = await storage.createFile(
      bucketId,
      ID.unique(),
      InputFile.fromBuffer(Buffer.from(json, 'utf8'), fileName),
      [Permission.read(Role.any())]
    );
    return {
      fileId: file.$id,
      url: `${process.env.APPWRITE_ENDPOINT}/storage/buckets/${bucketId}/files/${file.$id}/view?project=${process.env.APPWRITE_PROJECT_ID}`,
      bytes,
      rowCounts: snapshot.row_counts,
      createdAt,
    };
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * List existing snapshots in the backup bucket (newest first).
 * Local fallback: reads from /tmp/voteweb-backups.
 * @returns {Promise<Array<{fileId: string, name: string, bytes: number, createdAt: string}>>}
 */
async function listBackups() {
  if (!isAppwriteConfigured()) {
    ensureBackupDir();
    const files = fs.readdirSync(LOCAL_BACKUP_DIR).filter((f) => f.startsWith('voteweb-snapshot-') && f.endsWith('.json'));
    const mapped = files.map((name) => {
      const filePath = path.join(LOCAL_BACKUP_DIR, name);
      const stat = fs.statSync(filePath);
      // Prefer mtime as createdAt; try to parse timestamp from filename for stable sorting
      // filename format: voteweb-snapshot-2026-09-20T...-<id>.json
      return {
        fileId: name,
        name,
        bytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    });
    return mapped.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  const { client, bucketId } = backupConfig();
  const storage = new Storage(client);
  const res = await storage.listFiles(bucketId, [], 100);
  return (res.files || [])
    .filter((f) => f.name.startsWith('voteweb-snapshot-'))
    .map((f) => ({
      fileId: f.$id,
      name: f.name,
      bytes: f.sizeOriginal,
      createdAt: f.$createdAt,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Download a snapshot's JSON.
 * Local fallback: reads from filesystem.
 * @param {string} fileId
 * @returns {Promise<Object>}
 */
async function downloadBackup(fileId) {
  if (!isAppwriteConfigured()) {
    ensureBackupDir();
    // fileId may be the full filename (voteweb-snapshot-xxx.json) or an ID substring
    let filePath = path.join(LOCAL_BACKUP_DIR, fileId);
    if (!fs.existsSync(filePath)) {
      // Try to find file containing fileId (handles ID.unique() alone)
      const candidates = fs.readdirSync(LOCAL_BACKUP_DIR).filter((f) => f.includes(fileId));
      if (candidates.length === 0) {
        const err = new Error('Backup snapshot not found.');
        err.status = 404;
        err.code = 'BACKUP_NOT_FOUND';
        throw err;
      }
      filePath = path.join(LOCAL_BACKUP_DIR, candidates[0]);
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const err = new Error('Backup snapshot not found.');
      err.status = 404;
      err.code = 'BACKUP_NOT_FOUND';
      throw err;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  }

  const { client, bucketId } = backupConfig();
  const storage = new Storage(client);
  const res = await storage.getFileDownload(bucketId, fileId);
  // node-appwrite v29 returns a Response-like object with arrayBuffer()
  const buf = Buffer.from(await res.arrayBuffer());
  return JSON.parse(buf.toString('utf8'));
}

/**
 * Delete snapshots beyond the newest `keep` ones.
 * Local fallback: deletes oldest filesystem files.
 * @param {number} [keep]
 * @returns {Promise<{deleted: number, kept: number}>}
 */
async function pruneBackups(keep = RETENTION_DEFAULT) {
  if (!isAppwriteConfigured()) {
    ensureBackupDir();
    const files = await listBackups();
    const old = files.slice(keep);
    for (const f of old) {
      const filePath = path.join(LOCAL_BACKUP_DIR, f.name);
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.warn(`[local-backup] failed to delete ${filePath}: ${e.message}`);
      }
    }
    return { deleted: old.length, kept: files.length - old.length };
  }

  const { client, bucketId } = backupConfig();
  const storage = new Storage(client);
  const files = await listBackups();
  const old = files.slice(keep);
  for (const f of old) {
    await storage.deleteFile(bucketId, f.fileId);
  }
  return { deleted: old.length, kept: files.length - old.length };
}

/**
 * Topologically sort tables by FK dependencies (parents first).
 * @param {import('pg').Pool} pool
 * @param {string[]} tableNames
 * @returns {Promise<string[]>}
 */
async function orderTablesByDependencies(pool, tableNames) {
  const wanted = new Set(tableNames);
  const { rows } = await pool.query(
    `SELECT DISTINCT conrelid::regclass::text AS child,
            confrelid::regclass::text AS parent
       FROM pg_constraint
      WHERE contype = 'f'
        AND connamespace = 'public'::regnamespace`
  );
  const deps = new Map(tableNames.map((t) => [t, []]));
  for (const { child, parent } of rows) {
    if (wanted.has(child) && wanted.has(parent) && child !== parent) {
      deps.get(child).push(parent);
    }
  }
  // Kahn's algorithm; fall back to alphabetical for cycles (self-FKs handled above)
  const ordered = [];
  const remaining = new Map(deps);
  while (remaining.size) {
    const ready = [...remaining.entries()]
      .filter(([, ds]) => ds.every((d) => !remaining.has(d)))
      .map(([t]) => t)
      .sort();
    if (!ready.length) {
      ordered.push(...[...remaining.keys()].sort());
      break;
    }
    for (const t of ready) {
      ordered.push(t);
      remaining.delete(t);
    }
  }
  return ordered;
}

/**
 * Restore rows from a snapshot into the database. Data-only: assumes the
 * schema already exists (migrations already applied). Truncates every table
 * present in the snapshot (single statement = FK-safe), inserts in FK order,
 * then resyncs identity sequences.
 * @param {Object} snapshot
 * @param {import('pg').Pool} [pool]
 * @returns {Promise<Object>} table -> rows restored
 */
async function restoreSnapshot(snapshot, pool) {
  if (!snapshot || snapshot.format !== 'voteweb-db-snapshot') {
    const err = new Error('Not a valid voteweb-db-snapshot file.');
    err.status = 400;
    err.code = 'INVALID_SNAPSHOT';
    throw err;
  }
  const dbPool = pool || require('../db').pool;
  const client = await dbPool.connect();
  const tables = snapshot.tables || {};
  const restored = {};
  try {
    await client.query('BEGIN');

    // Only restore tables that actually exist in the current schema
    const dbTables = await listTables(dbPool);
    const existing = new Set(dbTables.map((t) => t.name));
    const present = Object.keys(tables).filter(
      (t) => existing.has(t) && Array.isArray(tables[t])
    );

    // Truncate everything being restored in ONE statement (FK-safe within a
    // single TRUNCATE). CASCADE guards against tables not in the snapshot.
    if (present.length) {
      await client.query(
        `TRUNCATE TABLE ${present.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`
      );
    }

    const ordered = await orderTablesByDependencies(dbPool, present);
    for (const name of ordered) {
      const rows = tables[name] || [];
      restored[name] = 0;
      for (const row of rows) {
        const colNames = Object.keys(row).filter((c) => c !== '$id' && c !== '$createdAt' && c !== '$updatedAt');
        if (!colNames.length) continue;
        const placeholders = colNames.map((_, i) => `$${i + 1}`);
        const { rowCount } = await client.query(
          `INSERT INTO "${name}" (${colNames.map((c) => `"${c}"`).join(', ')})
           VALUES (${placeholders})
           ON CONFLICT DO NOTHING`,
          colNames.map((c) => row[c])
        );
        restored[name] += rowCount || 0;
      }
    }

    // Resync identity/serial sequences past restored explicit ids.
    // Guards run as plain SELECTs first — a failed query inside the
    // transaction would abort it, so never fire setval speculatively.
    for (const name of ordered) {
      const { rows: hasId } = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
          LIMIT 1`,
        [name]
      );
      if (!hasId.length) continue;
      const { rows: seqRows } = await client.query(
        `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
        [name]
      );
      const seq = seqRows[0]?.seq;
      if (!seq) continue; // no serial/identity on `id`
      await client.query(
        `SELECT setval($1, COALESCE((SELECT MAX(id) FROM "${name}"), 1), TRUE)`,
        [seq]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return restored;
}

module.exports = {
  runBackup,
  listBackups,
  downloadBackup,
  pruneBackups,
  restoreSnapshot,
  buildSnapshot,
  listTables,
  RETENTION_DEFAULT,
  EXCLUDED_TABLES,
};
