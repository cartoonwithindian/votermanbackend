/**
 * Deterministic test database setup.
 *
 * The integration suite must be self-contained: it must not depend on the
 * dev `seed.js` output (which creates passwordless STU-001..STU-005). This
 * module builds the exact fixtures the tests reference and is safe to run
 * repeatedly against a disposable test database:
 *
 *   - Deterministic auth fixtures  STU001 (STUDENT) / ADMIN001 (ADMIN) with
 *     the credentials the test file expects.
 *   - The base election structure the tests hardcode (election 1 = 'Student
 *     Council Election', club 1 'Techno Club', positions 1-3, candidates 1-6).
 *   - Cleanup of leftovers from interrupted runs (test-runner students).
 *
 * Deliberately scoped: only the known seed election and the fixture students
 * are (re)created. Nothing else in the database is touched.
 */

const { hashPassword } = require('../src/lib/password');

const ELECTION_NAME = 'Student Council Election';
const FIXTURE_PW = {
  STU001: 'StudentPassword123!',
  ADMIN001: 'AdminPassword123!',
};

async function withTransaction(db, fn) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function teardownBaseElection(client) {
  // Order respects FK dependencies (children -> parents). Each statement is
  // issued separately — pg does not allow multi-statement prepared queries.
  const steps = [
    'DELETE FROM vote_receipts WHERE election_id = 1',
    'DELETE FROM votes WHERE election_id = 1',
    `DELETE FROM candidate_applications WHERE position_id IN (SELECT id FROM positions WHERE club_id = 1)`,
    'DELETE FROM voter_authorizations WHERE election_id = 1',
    'DELETE FROM announcements WHERE election_id = 1',
    'DELETE FROM support_requests WHERE election_id = 1',
    `DELETE FROM candidates WHERE position_id IN (SELECT id FROM positions WHERE club_id = 1)`,
    'DELETE FROM positions WHERE club_id = 1',
    'DELETE FROM clubs WHERE id = 1',
    `DELETE FROM candidate_applications WHERE position_id IN (SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id = 1))`,
    `DELETE FROM candidates WHERE position_id IN (SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id = 1))`,
    `DELETE FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id = 1)`,
    'DELETE FROM constituencies WHERE election_id = 1',
    `DELETE FROM elections WHERE id = 1 OR name = '${ELECTION_NAME.replace(/'/g, "''")}'`,
  ];
  for (const sql of steps) {
    await client.query(sql);
  }
}

async function teardownFixtureStudents(client) {
  // Remove auth fixtures + any leftover test-runner students from
  // interrupted runs. FK-aware order.
  const steps = [
    `DELETE FROM notifications WHERE user_id IN (SELECT id FROM students WHERE external_id IN ('STU001','ADMIN001') OR email LIKE '%@test.local')`,
    `DELETE FROM sessions WHERE student_id IN (SELECT id FROM students WHERE external_id IN ('STU001','ADMIN001') OR email LIKE '%@test.local')`,
    `DELETE FROM mfa_challenges WHERE student_id IN (SELECT id FROM students WHERE external_id IN ('STU001','ADMIN001') OR email LIKE '%@test.local')`,
    `DELETE FROM audit_logs WHERE actor_id IN (SELECT id FROM students WHERE external_id IN ('STU001','ADMIN001') OR email LIKE '%@test.local') OR actor_id IS NULL`,
    `DELETE FROM voter_authorizations WHERE student_id IN (SELECT id FROM students WHERE external_id IN ('STU001','ADMIN001') OR email LIKE '%@test.local')`,
    `DELETE FROM votes WHERE student_id IN (SELECT id FROM students WHERE external_id IN ('STU001','ADMIN001') OR email LIKE '%@test.local')`,
    `DELETE FROM vote_receipts WHERE student_id IN (SELECT id FROM students WHERE external_id IN ('STU001','ADMIN001') OR email LIKE '%@test.local')`,
    `DELETE FROM students WHERE external_id IN ('STU001','ADMIN001') OR email LIKE '%@test.local'`,
  ];
  for (const sql of steps) {
    await client.query(sql);
  }
}

async function createBaseElection(client) {
  const hash = await hashPassword(FIXTURE_PW.STU001);
  const adminHash = await hashPassword(FIXTURE_PW.ADMIN001);

  // Auth fixtures (created again; teardown ran first).
  await client.query(
    `INSERT INTO students (id, external_id, name, email, role, password_hash,
                           password_change_required, mfa_enabled,
                           failed_login_attempts, locked_until, is_active)
     VALUES (500, 'STU001', 'Student One', 'stu001@test.local', 'STUDENT', $1, FALSE, FALSE, 0, NULL, TRUE)`,
    [hash]
  );
  await client.query(
    `INSERT INTO students (id, external_id, name, email, role, password_hash,
                           password_change_required, mfa_enabled,
                           failed_login_attempts, locked_until, is_active)
     VALUES (501, 'ADMIN001', 'Admin One', 'admin001@test.local', 'ADMIN', $1, FALSE, FALSE, 0, NULL, TRUE)`,
    [adminHash]
  );

  // Base election structure with the deterministic ids the tests reference.
  await client.query(
    `INSERT INTO elections (id, name, description, status, start_time, end_time)
     VALUES (1, $1, 'Annual student council election', 'OPEN', NOW(), NOW() + INTERVAL '7 days')`,
    [ELECTION_NAME]
  );
  await client.query(
    `INSERT INTO clubs (id, election_id, name, description, display_order)
     VALUES (1, 1, 'Techno Club', 'Technology and programming enthusiasts club', 1)`
  );
  await client.query(
    `INSERT INTO positions (id, club_id, name, description, display_order, max_selections)
     VALUES
       (1, 1, 'Leader', 'Club president and main representative', 1, 1),
       (2, 1, 'Co-Leader', 'Vice president and deputy representative', 2, 1),
       (3, 1, 'Secretary', 'Takes meeting notes and manages communications', 3, 1)`
  );
  await client.query(
    `INSERT INTO candidates (id, position_id, name, description, display_order, is_active)
     VALUES
       (1, 1, 'Alex Chen', '3rd year Computer Science student', 1, TRUE),
       (2, 1, 'Jordan Lee', 'Active member of coding club', 2, TRUE),
       (3, 2, 'Taylor Kim', 'Technical lead in multiple projects', 1, TRUE),
       (4, 2, 'Morgan Patel', 'Experience in event coordination', 2, TRUE),
       (5, 3, 'Casey Wong', 'Detail-oriented with excellent writing skills', 1, TRUE),
       (6, 3, 'Riley Thompson', 'Previous secretary experience', 2, TRUE)`
  );

  // Keep sequences ahead of explicit ids so later inserts never collide.
  await client.query(`
    SELECT setval('elections_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM elections), 1), TRUE);
    SELECT setval('clubs_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM clubs), 1), TRUE);
    SELECT setval('positions_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM positions), 1), TRUE);
    SELECT setval('candidates_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM candidates), 1), TRUE);
    SELECT setval('students_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM students), 1), TRUE);
  `);
}

async function setupTestDatabase(db) {
  await withTransaction(db, async (client) => {
    await teardownFixtureStudents(client);
    await teardownBaseElection(client);
    await createBaseElection(client);
  });
  return { electionId: 1, clubId: 1, positions: [1, 2, 3], candidates: [1, 2, 3, 4, 5, 6] };
}

module.exports = { setupTestDatabase, ELECTION_NAME };