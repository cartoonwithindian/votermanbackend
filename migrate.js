/**
 * Migration Runner
 * Applies SQL migration files in order and tracks executed migrations
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Load environment - Railway provides env vars directly, .env is for local dev
require('dotenv').config();

// Validate required environment variables — allow MongoDB-only (Atlas M10) without Postgres
if (!process.env.DATABASE_URL) {
  if (process.env.MONGODB_URI) {
    console.log('MONGODB_URI set — skipping Postgres migrations (MongoDB-only mode)');
    console.log('Atlas: ' + process.env.MONGODB_URI.replace(/:[^@]*@/, ':***@'));
    process.exit(0);
  }
  console.error('ERROR: DATABASE_URL environment variable is not set!');
  console.error('Please set DATABASE_URL to your PostgreSQL connection string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Enable SSL for hosted Postgres (Railway, Render, etc.)
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 10000,
});

async function getAppliedMigrations() {
  const result = await pool.query(`
    SELECT name FROM migrations
    ORDER BY id ASC
  `);
  return result.rows.map(row => row.name);
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
}

async function runMigrations() {
  const args = process.argv.slice(2);
  const command = args[0] || 'up';

  console.log('=== VoteWeb Migration Runner ===');
  console.log('Database:', process.env.DATABASE_URL ? '(using DATABASE_URL)' : 'ERROR: No DATABASE_URL');
  console.log('SSL:', process.env.DB_SSL === 'true' ? 'enabled' : 'disabled');
  console.log('');

  // Test connection first
  try {
    await pool.query('SELECT 1');
    console.log('✓ Database connection established');
  } catch (err) {
    console.error('✗ Database connection failed:', err.message);
    process.exit(1);
  }

  await ensureMigrationsTable();

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = await getAppliedMigrations();

  if (command === 'up') {
    console.log(`Found ${files.length} migration files\n`);

    for (const file of files) {
      if (applied.includes(file)) {
        console.log(`Skipping (already applied): ${file}`);
        continue;
      }

      console.log(`Applying: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      try {
        await pool.query('BEGIN');
        await pool.query(sql);
        await pool.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        await pool.query('COMMIT');
        console.log(`  ✓ Applied: ${file}`);
      } catch (err) {
        await pool.query('ROLLBACK');
        console.error(`  ✗ Failed: ${file}`);
        console.error(`  Error: ${err.message}`);
        process.exit(1);
      }
    }

    console.log('\n=== All migrations complete ===');
  } else if (command === 'down') {
    const migrationName = args[1];
    if (!migrationName) {
      console.error('Usage: node migrate.js down <migration_name>');
      process.exit(1);
    }

    // Find the rollback file
    const rollbackFile = migrationName.replace('.sql', '_rollback.sql');
    const rollbackPath = path.join(migrationsDir, rollbackFile);

    if (!fs.existsSync(rollbackPath)) {
      console.error(`Rollback file not found: ${rollbackFile}`);
      process.exit(1);
    }

    console.log(`Rolling back: ${migrationName}`);
    const sql = fs.readFileSync(rollbackPath, 'utf8');

    try {
      await pool.query('BEGIN');
      await pool.query(sql);
      await pool.query('DELETE FROM migrations WHERE name = $1', [migrationName]);
      await pool.query('COMMIT');
      console.log(`  ✓ Rolled back: ${migrationName}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(`  ✗ Rollback failed: ${err.message}`);
      process.exit(1);
    }
  } else if (command === 'status') {
    console.log('Migration status:\n');
    console.log('Applied:');
    for (const m of applied) {
      console.log(`  ✓ ${m}`);
    }
    const pending = files.filter(f => !applied.includes(f));
    console.log('\nPending:');
    for (const f of pending) {
      console.log(`  ○ ${f}`);
    }
  } else if (command === 'reset') {
    console.log('WARNING: This will drop all tables and re-run migrations');
    console.log('Type "yes" to confirm: ');
    const answer = await new Promise(resolve => {
      process.stdin.once('data', d => resolve(d.toString().trim()));
    });

    if (answer !== 'yes') {
      console.log('Aborted.');
      process.exit(0);
    }

    // Drop all tables except migrations
    await pool.query(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN (
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
          AND tablename != 'migrations'
        ) LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);

    console.log('Tables dropped. Re-running migrations...\n');
    await runMigrations();
  }

  await pool.end();
}

runMigrations().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
