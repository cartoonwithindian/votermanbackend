#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');

const COLUMNS = [
  'id', 'external_id', 'name', 'email', 'is_active', 'created_at', 'updated_at',
  'password_hash', 'password_change_required', 'mfa_enabled', 'mfa_secret_encrypted',
  'failed_login_attempts', 'locked_until', 'last_login_at', 'role', 'username',
  'mobile_number', 'enrollment_number', 'student_id', 'official_email',
  'current_login_email', 'email_verified', 'roll_number', 'department',
  'year_or_semester', 'voting_eligible', 'section', 'profile_image_url',
];

const BOOLEAN_COLS = new Set([
  'is_active', 'password_change_required', 'mfa_enabled', 'email_verified', 'voting_eligible',
]);
const INT_COLS = new Set(['id', 'failed_login_attempts']);
const TIMESTAMP_COLS = new Set(['created_at', 'updated_at', 'locked_until', 'last_login_at']);
const ALLOWED_ROLES = new Set(['STUDENT', 'CANDIDATE', 'ADMIN', 'CAD']);
const YEAR_RE = /^\d+ Sem$/;

function parseArgs(argv) {
  const args = { dryRun: false, target: 'both', yes: false, sql: null };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes') args.yes = true;
    else if (a.startsWith('--target=')) args.target = a.slice('--target='.length);
    else if (a.startsWith('--sql=')) args.sql = a.slice('--sql='.length);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!['postgres', 'mongo', 'both'].includes(args.target)) {
    console.error(`Invalid --target: ${args.target} (use postgres, mongo, or both)`);
    process.exit(1);
  }
  if (!args.sql) args.sql = path.resolve(__dirname, '../../../candidate/students.sql');
  return args;
}

function splitValues(body) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") {
      if (inQuote && body[i + 1] === "'") {
        cur += "'";
        i++;
        continue;
      }
      inQuote = !inQuote;
      cur += ch;
    } else if (ch === ',' && !inQuote) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function unquote(v) {
  if (v === 'NULL') return null;
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function parseSql(sqlPath) {
  const text = fs.readFileSync(sqlPath, 'utf8');
  const lines = text.split('\n');
  const insertIdx = lines.findIndex((l) => l.startsWith('INSERT INTO public.students'));
  if (insertIdx === -1) {
    console.error('ERROR: INSERT INTO public.students statement not found.');
    process.exit(1);
  }
  const headerMatch = lines[insertIdx].match(/\(([^)]+)\)\s*VALUES/);
  if (!headerMatch) {
    console.error('ERROR: could not parse INSERT column list.');
    process.exit(1);
  }
  const headerCols = headerMatch[1].split(',').map((c) => c.trim());
  if (headerCols.length !== COLUMNS.length || headerCols.some((c, i) => c !== COLUMNS[i])) {
    console.error('ERROR: INSERT columns do not match expected 28-column layout.');
    console.error(`  found: ${headerCols.join(', ')}`);
    process.exit(1);
  }

  const rows = [];
  for (let i = insertIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('(')) break;
    let body = line;
    if (body.endsWith(');')) body = body.slice(0, -2);
    else if (body.endsWith('),')) body = body.slice(0, -2);
    else {
      console.error(`ERROR: line ${i + 1} does not end with ), or );`);
      process.exit(1);
    }
    body = body.slice(1);
    const vals = splitValues(body).map(unquote);
    if (vals.length !== COLUMNS.length) {
      console.error(`ERROR: line ${i + 1} has ${vals.length} values, expected ${COLUMNS.length}`);
      process.exit(1);
    }
    const row = {};
    COLUMNS.forEach((c, idx) => { row[c] = vals[idx]; });
    rows.push(row);
  }
  return rows;
}

function validate(rows) {
  const errors = [];
  const seenExt = new Map();
  const seenIds = new Map();

  for (const row of rows) {
    const label = row.external_id || row.id;
    if (!row.external_id) errors.push(`row id=${row.id}: missing external_id`);
    if (!row.name) errors.push(`row ${label}: missing name`);
    if (row.external_id) {
      if (seenExt.has(row.external_id)) {
        errors.push(`duplicate external_id: ${row.external_id} (ids ${seenExt.get(row.external_id)} and ${row.id})`);
      }
      seenExt.set(row.external_id, row.id);
    }
    if (seenIds.has(row.id)) errors.push(`duplicate id: ${row.id}`);
    seenIds.set(row.id, row.external_id);

    if (!ALLOWED_ROLES.has(row.role)) errors.push(`row ${label}: invalid role ${row.role}`);
    if (row.year_or_semester !== null && !YEAR_RE.test(row.year_or_semester)) {
      errors.push(`row ${label}: invalid year_or_semester ${row.year_or_semester}`);
    }
    for (const col of BOOLEAN_COLS) {
      if (row[col] !== null && row[col] !== 't' && row[col] !== 'f') {
        errors.push(`row ${label}: invalid ${col}=${row[col]}`);
      }
    }
    for (const col of INT_COLS) {
      if (row[col] !== null && !/^-?\d+$/.test(row[col])) {
        errors.push(`row ${label}: invalid ${col}=${row[col]}`);
      }
    }
    if (row.username !== null && row.username.length > 50) {
      errors.push(`row ${label}: username longer than 50 chars`);
    }
    if (row.mobile_number !== null && row.mobile_number.length > 15) {
      errors.push(`row ${label}: mobile_number longer than 15 chars`);
    }
  }
  return errors;
}

function toPgParams(row) {
  const params = [];
  for (const col of COLUMNS) {
    let v = row[col];
    if (v === null) {
      params.push(null);
    } else if (BOOLEAN_COLS.has(col)) {
      params.push(v === 't');
    } else if (INT_COLS.has(col)) {
      params.push(parseInt(v, 10));
    } else if (col === 'mfa_secret_encrypted') {
      params.push(Buffer.from(String(v).replace(/^\\x/, ''), 'hex'));
    } else {
      params.push(v);
    }
  }
  return params;
}

function toMongoDoc(row) {
  const fileId = parseInt(row.id, 10);
  const doc = {
    externalId: row.external_id,
    name: row.name,
    email: row.email,
    role: row.role,
    department: row.department,
    year: row.year_or_semester,
    section: row.section,
    votingEligible: row.voting_eligible === 't',
    isActive: row.is_active === 't',
    passwordChangeRequired: row.password_change_required === 't',
    mfaEnabled: row.mfa_enabled === 't',
    studentId: row.student_id,
    officialEmail: row.official_email,
    currentLoginEmail: row.current_login_email,
    emailVerified: row.email_verified === 't',
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
  const extras = {
    passwordHash: row.password_hash,
    username: row.username,
    mobileNumber: row.mobile_number,
    enrollmentNumber: row.enrollment_number,
    rollNumber: row.roll_number,
    profileImageUrl: row.profile_image_url,
    mfaSecretEncrypted: row.mfa_secret_encrypted,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
    lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
    failedLoginAttempts: row.failed_login_attempts !== null ? parseInt(row.failed_login_attempts, 10) : 0,
  };
  for (const [k, v] of Object.entries(extras)) {
    if (v !== null && v !== undefined) doc[k] = v;
  }
  if (extras.failedLoginAttempts === 0) doc.failedLoginAttempts = 0;
  return { fileId, doc };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function runPostgres(args, rows) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const client = await pool.connect();
  const summary = { inserted: 0, updated: 0, preserved: 0, skippedIdCollisions: 0, skippedEmailConflict: 0 };

  try {
    const existing = await client.query('SELECT id, external_id, username, student_id, LOWER(current_login_email) AS cle, LOWER(email) AS email_lower FROM students');
    const byExt = new Map(existing.rows.map((r) => [r.external_id, r]));
    const usedIds = new Set(existing.rows.map((r) => r.id));
    const byUsername = new Map(existing.rows.filter((r) => r.username).map((r) => [r.username, r]));
    const byStudentId = new Map(existing.rows.filter((r) => r.student_id).map((r) => [r.student_id, r]));
    const byEmail = new Map(existing.rows.filter((r) => r.cle).map((r) => [r.cle, r]));
    const emailLiveByExt = new Map(existing.rows.filter((r) => r.email_lower).map((r) => [r.email_lower, r]));

    const extInFile = new Set(rows.map((r) => r.external_id));
    summary.preserved = existing.rows.filter((r) => !extInFile.has(r.external_id)).length;

    for (const row of rows) {
      const clashOwner = (map, key, currentExt) => {
        if (key === null || key === undefined) return null;
        const hit = map.get(key);
        return hit && hit.external_id !== currentExt ? hit : null;
      };
      const u = clashOwner(byUsername, row.username, row.external_id);
      if (u) throw new Error(`username collision: ${row.username} held by external_id=${u.external_id}`);
      const s = clashOwner(byStudentId, row.student_id, row.external_id);
      if (s) throw new Error(`student_id collision: ${row.student_id} held by external_id=${s.external_id}`);
      const e = clashOwner(byEmail, row.current_login_email ? row.current_login_email.toLowerCase() : null, row.external_id);
      if (e) throw new Error(`current_login_email collision: ${row.current_login_email} held by external_id=${e.external_id}`);
    }

    if (args.dryRun) {
      for (const row of rows) {
        if (byExt.has(row.external_id)) summary.updated++;
        else {
          const clash = row.email ? emailLiveByExt.get(String(row.email).toLowerCase()) : null;
          if (clash && clash.external_id !== row.external_id) summary.skippedEmailConflict++;
          else summary.inserted++;
        }
      }
      const maxFileId = Math.max(...rows.map((r) => parseInt(r.id, 10)));
      const seqRow = await client.query("SELECT last_value FROM students_id_seq");
      summary.sequence = { maxFileId, lastValue: Number(seqRow.rows[0].last_value) };
      return summary;
    }

    const backupPath = path.resolve(__dirname, '../backups', `students_pre_import_${timestamp()}.json`);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    const dump = await client.query('SELECT * FROM students ORDER BY id');
    fs.writeFileSync(backupPath, JSON.stringify({ exported_at: new Date().toISOString(), row_count: dump.rowCount, rows: dump.rows }, null, 2));
    summary.backup = backupPath;

    const updateCols = COLUMNS.filter((c) => c !== 'id' && c !== 'external_id');
    const updateSet = updateCols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const updateSql = `UPDATE students SET ${updateSet} WHERE external_id = $1`;

    await client.query('BEGIN');
    for (const row of rows) {
      const params = toPgParams(row);
      const existingRow = byExt.get(row.external_id);
      if (existingRow) {
        const indexed = {};
        COLUMNS.forEach((c, i) => { indexed[c] = params[i]; });
        await client.query(updateSql, [row.external_id, ...updateCols.map((c) => indexed[c])]);
        summary.updated++;
      } else {
        const emailClash = row.email ? emailLiveByExt.get(String(row.email).toLowerCase()) : null;
        if (emailClash && emailClash.external_id !== row.external_id) {
          summary.skippedEmailConflict++;
          continue;
        }
        if (usedIds.has(parseInt(row.id, 10))) {
          const insertNoId = `INSERT INTO students (${COLUMNS.slice(1).join(', ')}) VALUES (${COLUMNS.slice(1).map((_, i) => `$${i + 1}`).join(', ')})`;
          await client.query(insertNoId, params.slice(1));
          summary.skippedIdCollisions++;
        } else {
          const insertSql = `INSERT INTO students (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`;
          await client.query(insertSql, params);
          usedIds.add(parseInt(row.id, 10));
        }
        summary.inserted++;
      }
    }

    const seqState = await client.query('SELECT last_value FROM students_id_seq');
    const maxRow = await client.query('SELECT COALESCE(MAX(id), 0) AS m FROM students');
    const maxId = Number(maxRow.rows[0].m);
    if (maxId > Number(seqState.rows[0].last_value)) {
      await client.query("SELECT setval('students_id_seq', $1, true)", [maxId]);
      summary.sequenceSetval = maxId;
    }
    await client.query('COMMIT');
    return summary;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function runMongo(args, rows) {
  const client = new MongoClient(process.env.MONGODB_URI);
  const summary = { inserted: 0, updated: 0, preserved: 0, assignedObjectId: 0, skippedEmailConflict: 0 };
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'voteweb');
    const col = db.collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');

    const existingFull = await col.find({}, { projection: { _id: 1, externalId: 1, email: 1 } }).toArray();
    const byExt = new Map();
    const emailHolders = new Map();
    const usedIds = new Set();
    for (const d of existingFull) {
      byExt.set(d.externalId, d);
      usedIds.add(d._id);
      if (d.email) emailHolders.set(d.email.toLowerCase(), d);
    }
    const extInFile = new Set(rows.map((r) => r.external_id));
    summary.preserved = existingFull.filter((d) => !extInFile.has(d.externalId)).length;

    const ops = [];
    for (const row of rows) {
      const { fileId, doc } = toMongoDoc(row);
      const current = byExt.get(row.external_id);
      if (current) {
        summary.updated++;
        ops.push({ updateOne: { filter: { _id: current._id }, update: { $set: doc } } });
      } else {
        const emailClash = doc.email ? emailHolders.get(String(doc.email).toLowerCase()) : null;
        if (emailClash) {
          summary.skippedEmailConflict++;
          continue;
        }
        const insertDoc = { ...doc };
        if (!usedIds.has(fileId)) {
          insertDoc._id = fileId;
          insertDoc.postgresId = fileId;
          usedIds.add(fileId);
        } else {
          insertDoc.postgresId = fileId;
          summary.assignedObjectId++;
        }
        summary.inserted++;
        if (doc.email) emailHolders.set(String(doc.email).toLowerCase(), { _id: insertDoc._id ?? fileId, externalId: row.external_id, email: doc.email });
        ops.push({ insertOne: { document: insertDoc } });
      }
    }

    if (args.dryRun) return summary;

    const backupPath = path.resolve(__dirname, '../backups', `mongo_students_pre_import_${timestamp()}.json`);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    const dump = await col.find({}).toArray();
    fs.writeFileSync(backupPath, JSON.stringify({ exported_at: new Date().toISOString(), row_count: dump.length, rows: dump }, null, 2));
    summary.backup = backupPath;

    const BATCH = 200;
    for (let i = 0; i < ops.length; i += BATCH) {
      await col.bulkWrite(ops.slice(i, i + BATCH), { ordered: true });
    }
    return summary;
  } finally {
    await client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  if (!fs.existsSync(args.sql)) {
    console.error(`ERROR: SQL file not found: ${args.sql}`);
    process.exit(1);
  }

  const rows = parseSql(args.sql);
  console.log(`Parsed ${rows.length} rows from ${args.sql}`);

  const errors = validate(rows);
  if (errors.length) {
    console.error('\nValidation failed:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('Validation passed: unique external_id, valid roles, valid years, 28-column arity');

  if (!args.dryRun && !args.yes) {
    if (!process.stdin.isTTY) {
      console.error('Refusing to write without --yes (or run interactively). Use --dry-run to preview.');
      process.exit(1);
    }
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(`Import ${rows.length} rows into ${args.target}? (yes/no) `, resolve));
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  let pgSummary = null;
  let mongoSummary = null;

  if (args.target === 'postgres' || args.target === 'both') {
    if (!process.env.DATABASE_URL) {
      console.error('ERROR: DATABASE_URL is not set.');
      process.exit(1);
    }
    console.log('\nPostgres:');
    pgSummary = await runPostgres(args, rows);
    console.log(JSON.stringify(pgSummary, null, 2));
  }

  if (args.target === 'mongo' || args.target === 'both') {
    if (!process.env.MONGODB_URI) {
      console.error('ERROR: MONGODB_URI is not set.');
      process.exit(1);
    }
    console.log('\nMongo:');
    mongoSummary = await runMongo(args, rows);
    console.log(JSON.stringify(mongoSummary, null, 2));
  }

  const duration = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${args.dryRun ? 'Dry run' : 'Import'} complete in ${duration}s`);
  if (pgSummary) {
    console.log(`Postgres: ${pgSummary.inserted} inserted, ${pgSummary.updated} updated, ${pgSummary.preserved} live-only rows preserved${pgSummary.backup ? `, backup: ${pgSummary.backup}` : ''}`);
  }
  if (mongoSummary) {
    console.log(`Mongo: ${mongoSummary.inserted} inserted, ${mongoSummary.updated} updated, ${mongoSummary.preserved} live-only docs preserved${mongoSummary.backup ? `, backup: ${mongoSummary.backup}` : ''}`);
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
