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
 *     Council Election', constituency 1 'BCA 2nd Year Section A', CR seats
 *     positions 1-2, candidates 1-4).
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
    `DELETE FROM candidate_applications WHERE position_id IN (SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id = 1))`,
    'DELETE FROM voter_authorizations WHERE election_id = 1',
    'DELETE FROM announcements WHERE election_id = 1',
    'DELETE FROM support_requests WHERE election_id = 1',
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
                           failed_login_attempts, locked_until, is_active,
                           department, year_or_semester, section, voting_eligible)
     VALUES (500, 'STU001', 'Student One', 'stu001@test.local', 'STUDENT', $1, FALSE, FALSE, 0, NULL, TRUE,
             'BCA', '2nd Year', 'A', TRUE)`,
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
    `INSERT INTO elections (id, name, description, status, start_time, end_time, category)
     VALUES (1, $1, 'Annual student council election', 'OPEN', NOW(), NOW() + INTERVAL '7 days', 'CLASS_REPRESENTATIVE')`,
    [ELECTION_NAME]
  );
  await client.query(
    `INSERT INTO constituencies (id, election_id, department, year, section, name, is_active, voting_open)
     VALUES (1, 1, 'BCA', '2nd Year', 'A', 'BCA 2nd Year Section A', TRUE, TRUE)`
  );
  await client.query(
    `INSERT INTO positions (id, constituency_id, name, description, display_order, max_selections)
     VALUES
       (1, 1, 'Class Representative (Boys)', 'Class representative for boys of the section', 1, 1),
       (2, 1, 'Class Representative (Girls)', 'Class representative for girls of the section', 2, 1)`
  );
  await client.query(
    `INSERT INTO candidates (id, position_id, name, description, display_order, is_active)
     VALUES
       (1, 1, 'Alex Chen', 'CR candidate for boys', 1, TRUE),
       (2, 1, 'Jordan Lee', 'CR candidate for boys', 2, TRUE),
       (3, 2, 'Taylor Kim', 'CR candidate for girls', 1, TRUE),
       (4, 2, 'Morgan Patel', 'CR candidate for girls', 2, TRUE)`
  );

  // Keep sequences ahead of explicit ids so later inserts never collide.
  await client.query(`
    SELECT setval('elections_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM elections), 1), TRUE);
    SELECT setval('constituencies_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM constituencies), 1), TRUE);
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
  return { electionId: 1, constituencyId: 1, positions: [1, 2], candidates: [1, 2, 3, 4] };
}

module.exports = { setupTestDatabase, ELECTION_NAME };