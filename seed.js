/**
 * Seed Script
 * Creates development/test data for testing the schema
 *
 * WARNING: This is for development only - do not run in production
 */

const { Pool } = require('pg');

// Load environment
require('dotenv').config();

// PRODUCTION SAFETY: this script inserts development/test data.
// Never run it against a production database unless you really mean to.
if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOWED_IN_PROD !== 'true') {
  console.error('Refusing to seed development data in production.');
  console.error('Set SEED_ALLOWED_IN_PROD=true to override (NOT recommended).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function seed() {
  console.log('=== Seed Script ===\n');

  const args = process.argv.slice(2);
  const command = args[0] || 'up';

  if (command === 'down') {
    console.log('Rolling back seed data...\n');
    await pool.query(`
      DELETE FROM vote_receipts WHERE election_id = 1;
      DELETE FROM votes WHERE election_id = 1;
      DELETE FROM voter_authorizations WHERE election_id = 1;
      DELETE FROM candidates WHERE position_id IN (
        SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id = 1)
      );
      DELETE FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id = 1);
      DELETE FROM constituencies WHERE election_id = 1;
      DELETE FROM elections WHERE id = 1;
      DELETE FROM students WHERE external_id LIKE 'STU-%';
    `);
    console.log('Seed data rolled back.');
    await pool.end();
    return;
  }

  if (command !== 'up') {
    console.log('Usage: node seed.js [up|down]');
    await pool.end();
    return;
  }

  // Check if seed already exists
  const existingElection = await pool.query(`
    SELECT id FROM elections WHERE name = 'Student Council Election'
  `);

  if (existingElection.rows.length > 0) {
    console.log('Seed data already exists. Use "node seed.js down" to remove first.');
    console.log('(Or run "npm run migrate:reset" to reset everything)\n');
    await pool.end();
    return;
  }

  console.log('Creating seed data...\n');

  try {
    await pool.query('BEGIN');

    // Create test students
    console.log('1. Creating students...');
    const students = [
      { id: 1, external_id: 'STU-001', name: 'Alice Johnson', email: 'alice@example.edu' },
      { id: 2, external_id: 'STU-002', name: 'Bob Smith', email: 'bob@example.edu' },
      { id: 3, external_id: 'STU-003', name: 'Carol Williams', email: 'carol@example.edu' },
      { id: 4, external_id: 'STU-004', name: 'David Brown', email: 'david@example.edu' },
      { id: 5, external_id: 'STU-005', name: 'Eva Martinez', email: 'eva@example.edu' },
    ];

    for (const s of students) {
      await pool.query(
        `INSERT INTO students (id, external_id, name, email, department, year_or_semester, section)
         VALUES ($1, $2, $3, $4, 'BCA', '2nd Year', 'A')`,
        [s.id, s.external_id, s.name, s.email]
      );
    }
    console.log(`   Created ${students.length} students\n`);

    // Create election
    console.log('2. Creating election...');
    const electionResult = await pool.query(`
      INSERT INTO elections (name, description, status, start_time, end_time, category)
      VALUES (
        'Student Council Election',
        'Annual student council election for the upcoming academic year',
        'OPEN',
        NOW(),
        NOW() + INTERVAL '7 days',
        'CLASS_REPRESENTATIVE'
      )
      RETURNING id
    `);

    const electionId = electionResult.rows[0].id;
    console.log(`   Election ID: ${electionId}\n`);

    // Create constituency
    console.log('3. Creating constituency...');
    const constituencyResult = await pool.query(`
      INSERT INTO constituencies (election_id, department, year, section, name)
      VALUES ($1, 'BCA', '2nd Year', 'A', 'BCA 2nd Year Section A')
      RETURNING id
    `, [electionId]);

    const constituencyId = constituencyResult.rows[0].id;
    console.log(`   Constituency ID: ${constituencyId}\n`);

    // Create positions
    console.log('4. Creating positions...');
    const positions = [
      { name: 'Class Representative (Boys)', description: 'Class representative for boys of the section' },
      { name: 'Class Representative (Girls)', description: 'Class representative for girls of the section' },
    ];

    const positionIds = [];
    let order = 1;
    for (const p of positions) {
      const result = await pool.query(`
        INSERT INTO positions (constituency_id, name, description, display_order)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [constituencyId, p.name, p.description, order]);
      positionIds.push(result.rows[0].id);
      order++;
    }
    console.log(`   Created ${positionIds.length} positions\n`);

    // Create candidates
    console.log('5. Creating candidates...');
    const candidates = [
      { positionIdx: 0, name: 'Alex Chen', description: '3rd year Computer Science student' },
      { positionIdx: 0, name: 'Jordan Lee', description: 'Active class representative candidate' },
      { positionIdx: 1, name: 'Taylor Kim', description: 'Student council volunteer' },
      { positionIdx: 1, name: 'Morgan Patel', description: 'Experience in event coordination' },
    ];

    for (const c of candidates) {
      const displayOrder = candidates.filter(
        (x, i) => i <= candidates.indexOf(c) && x.positionIdx === c.positionIdx
      ).length;
      await pool.query(`
        INSERT INTO candidates (position_id, name, description, display_order)
        VALUES ($1, $2, $3, $4)
      `, [positionIds[c.positionIdx], c.name, c.description, displayOrder]);
    }
    console.log(`   Created ${candidates.length} candidates\n`);

    // Create voter authorizations
    console.log('6. Creating voter authorizations...');
    for (const s of students) {
      await pool.query(`
        INSERT INTO voter_authorizations (student_id, election_id, is_authorized)
        VALUES ($1, $2, true)
      `, [s.id, electionId]);
    }
    console.log(`   Authorized ${students.length} students for the election\n`);

    await pool.query('COMMIT');

    console.log('=== Seed complete ===');
    console.log('\nTest data created:');
    console.log(`- ${students.length} students`);
    console.log('- 1 election (Student Council Election)');
    console.log('- 1 constituency (BCA 2nd Year Section A)');
    console.log(`- ${positions.length} positions`);
    console.log(`- ${candidates.length} candidates`);
    console.log(`- ${students.length} voter authorizations`);

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    throw err;
  }

  await pool.end();
}

seed().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});