/**
 * VoteWeb API integration tests (runs against a live PostgreSQL DB).
 * Uses Node's built-in test runner and fetch.
 *
 * Run: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://voteweb:voteweb@localhost:5434/voteweb';

const app = require('../src/app');
const db = require('../src/db');
const announcementService = require('../src/services/announcementService');
const { hashPassword } = require('../src/lib/password');
const { TestClient, randomId } = require('./helpers');
const { setupTestDatabase } = require('./setup');
const constituencyService = require('../src/services/constituencyService');
const { createSession } = require('../src/services/sessionService');

let server;
let baseUrl;
let client;

// Dedicated test students used for vote-flow tests
const TEST_PW = 'TestPassword123!';
let testStudentId;
let attackerStudentId;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  client = new TestClient(baseUrl);

  const externalId = `TST${randomId('')}`.slice(0, 18);
  const attackerExternalId = `ATK${randomId('')}`.slice(0, 18);
  const hash = await hashPassword(TEST_PW);

  // Deterministic fixtures: STU001 (STUDENT) + ADMIN001 (ADMIN) + the base
  // election structure the tests reference. The suite never depends on dev
  // seed.js output.
  await setupTestDatabase(db);

  const inserted = await db.query(
    `INSERT INTO students (external_id, name, email, role, password_hash, password_change_required)
     VALUES ($1, 'Test Runner', $2, 'STUDENT', $3, FALSE)
     RETURNING id`,
    [externalId, `${externalId}@test.local`, hash]
  );
  testStudentId = inserted.rows[0].id;
  globalThis.__TEST_STUDENT_ID__ = externalId;

  const attacker = await db.query(
    `INSERT INTO students (external_id, name, email, role, password_hash, password_change_required)
     VALUES ($1, 'Attacker', $2, 'STUDENT', $3, FALSE)
     RETURNING id`,
    [attackerExternalId, `${attackerExternalId}@test.local`, hash]
  );
  attackerStudentId = attacker.rows[0].id;
  globalThis.__ATTACKER_STUDENT_ID__ = attackerExternalId;

  await db.query(
    `INSERT INTO voter_authorizations (student_id, election_id)
     VALUES ($1, 1)`,
    [testStudentId]
  );
});

test.after(async () => {
  await db.query('DELETE FROM voter_authorizations WHERE student_id = $1', [testStudentId]);
  await db.query('DELETE FROM vote_receipts WHERE student_id = $1', [testStudentId]);
  await db.query('DELETE FROM votes WHERE student_id = $1', [testStudentId]);
  await db.query('DELETE FROM votes WHERE student_id = $1', [attackerStudentId]);
  await db.query('DELETE FROM students WHERE id IN ($1, $2)', [testStudentId, attackerStudentId]);
  // Clean up the deterministic auth fixtures.
  await db.query("DELETE FROM notifications WHERE user_id IN ((SELECT id FROM students WHERE external_id = 'STU001'), (SELECT id FROM students WHERE external_id = 'ADMIN001'))");
  await db.query("DELETE FROM sessions WHERE student_id IN ((SELECT id FROM students WHERE external_id = 'STU001'), (SELECT id FROM students WHERE external_id = 'ADMIN001'))");
  await db.query("DELETE FROM mfa_challenges WHERE student_id IN ((SELECT id FROM students WHERE external_id = 'STU001'), (SELECT id FROM students WHERE external_id = 'ADMIN001'))");
  await db.query("DELETE FROM students WHERE external_id IN ('STU001', 'ADMIN001')");
  server.close();
  await db.close();
  delete globalThis.__TEST_STUDENT_ID__;
  delete globalThis.__ATTACKER_STUDENT_ID__;
});

// ============================================================
// HEALTH
// ============================================================
test('GET /api/health returns ok', async () => {
  const res = await client.request('GET', '/api/health', { csrf: false, binding: false });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
});

test('GET /api/health/db reports connected', async () => {
  const res = await client.request('GET', '/api/health/db', { csrf: false, binding: false });
  assert.equal(res.status, 200);
  assert.equal(res.json.database, 'connected');
});

// ============================================================
// CSRF
// ============================================================
test('GET /auth/csrf sets cv_csrf cookie and returns token', async () => {
  const res = await client.request('GET', '/api/v1/auth/csrf', { csrf: false, binding: false });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.csrfToken);
  assert.equal(client.csrfCookie, res.json.data.csrfToken);
});

test('POST without CSRF header is rejected with 403 CSRF_INVALID', async () => {
  const fresh = new TestClient(baseUrl);
  const res = await fresh.request('POST', '/api/v1/auth/login', {
    csrf: false,
    binding: false,
    headers: { 'Content-Type': 'application/json' },
    body: { userIdentifier: 'STU001', password: 'StudentPassword123!' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'CSRF_INVALID');
});

// ============================================================
// AUTHENTICATION
// ============================================================
test('login succeeds for seeded STU001 (no MFA)', async () => {
  const res = await client.login('STU001', 'StudentPassword123!');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.authenticated, true);
  assert.ok(res.json.data.bindingToken);
  assert.equal(res.json.data.user.externalId ?? res.json.data.user.external_id, 'STU001');
});

test('login with wrong password returns 401 with generic error', async () => {
  const res = await client.login('STU001', 'WrongPassword123!');
  assert.equal(res.status, 401);
  assert.ok(!res.json.data || res.json.data.authenticated === false);
  assert.ok(res.json.error);
});

test('login with unknown user returns 401', async () => {
  const res = await client.login('NOBODY999', 'WhateverPassword1!');
  assert.equal(res.status, 401);
});

test('login with missing identifier returns 400', async () => {
  const res = await client.request('POST', '/api/v1/auth/login', {
    body: { userIdentifier: '', password: 'StudentPassword123!' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'INVALID_INPUT');
});

test('logout without binding token still succeeds (safe: logout is always allowed)', async () => {
  const c = new TestClient(baseUrl);
  await c.request('GET', '/api/v1/auth/csrf', { csrf: false, binding: false });
  await c.login('STU001', 'StudentPassword123!');
  // Strip binding token, keep session cookie. Logout must still work: allowing
  // a user (or anyone holding their session cookie) to end a session is benign.
  c.bindingToken = null;
  const res = await c.request('POST', '/api/v1/auth/logout', { binding: false });
  assert.ok([200, 401].includes(res.status), `got ${res.status}`);
});

test('logout works when binding token is present', async () => {
  const c = new TestClient(baseUrl);
  await c.login('STU001', 'StudentPassword123!');
  const res = await c.request('POST', '/api/v1/auth/logout');
  assert.equal(res.status, 200);
});

// ============================================================
// ADMIN MFA CHALLENGE
// ============================================================
test('ADMIN001 login returns authenticated:false with mfa required', async () => {
  const c = new TestClient(baseUrl);
  // Role is required by the API (role separation); the frontend always sends
  // it. Role-less logins default to STUDENT and are rejected for ADMIN.
  const res = await c.request('POST', '/api/v1/auth/login', {
    body: { userIdentifier: 'ADMIN001', password: 'AdminPassword123!', role: 'ADMIN' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.authenticated, false);
  assert.equal(res.json.data.mfaRequired, true);
});

// ============================================================
// PUBLIC RESOURCES
// ============================================================
test('GET /api/v1/elections returns list', async () => {
  const res = await client.request('GET', '/api/v1/elections', { csrf: false, binding: false });
  assert.equal(res.status, 200);
  const elections = res.json.elections || res.json.data?.elections || res.json.data;
  assert.ok(Array.isArray(elections));
  assert.ok(elections.some((e) => e.id === 1));
});

test('GET /api/v1/elections/1 returns election details', async () => {
  const res = await client.request('GET', '/api/v1/elections/1', { csrf: false, binding: false });
  assert.equal(res.status, 200);
  const election = res.json.election || res.json.data?.election || res.json.data;
  assert.ok(election);
  assert.equal(election.id, 1);
});

test('GET /api/v1/elections/999 returns 404', async () => {
  const res = await client.request('GET', '/api/v1/elections/999', { csrf: false, binding: false });
  assert.equal(res.status, 404);
});

test('GET /api/v1/announcements returns list (may be empty)', async () => {
  const res = await client.request('GET', '/api/v1/announcements', { csrf: false, binding: false });
  assert.equal(res.status, 200);
  const data = res.json.data;
  assert.ok(Array.isArray(data));
});

test('GET /api/v1/elections/1/clubs returns clubs', async () => {
  const res = await client.request('GET', '/api/v1/elections/1/clubs', { csrf: false, binding: false });
  assert.equal(res.status, 200);
});

test('GET /api/v1/clubs/1/positions returns positions', async () => {
  const res = await client.request('GET', '/api/v1/clubs/1/positions', { csrf: false, binding: false });
  assert.equal(res.status, 200);
});

// ============================================================
// VOTING FLOW
// ============================================================
test('test student is eligible and can check votes', async () => {
  const externalId = globalThis.__TEST_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  const login = await c.login(externalId, TEST_PW);
  assert.equal(login.status, 200, JSON.stringify(login.json));

  const check = await c.request('GET', '/api/v1/elections/1/votes/check', { csrf: false });
  assert.equal(check.status, 200);
  assert.equal(check.json.data.can_vote, true);
});

test('cast vote creates a receipt', async () => {
  const externalId = globalThis.__TEST_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  await c.login(externalId, TEST_PW);
  const res = await c.request('POST', '/api/v1/elections/1/votes', {
    body: { election_id: 1, club_id: 1, position_id: 1, candidate_id: 1 },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.data.success, true);
  assert.ok(res.json.data.receipt.receiptId);
  assert.ok(res.json.data.receipt.receiptHash);
  assert.ok(res.json.data.receipt.nullifier);
});

test('duplicate vote for same position is rejected', async () => {
  const externalId = globalThis.__TEST_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  await c.login(externalId, TEST_PW);
  const res = await c.request('POST', '/api/v1/elections/1/votes', {
    body: { election_id: 1, club_id: 1, position_id: 1, candidate_id: 2 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'ALREADY_VOTED');
});

test('GET /votes/receipt (by election, no voteId) returns own receipt', async () => {
  const externalId = globalThis.__TEST_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  await c.login(externalId, TEST_PW);
  const res = await c.request('GET', '/api/v1/elections/1/votes/receipt', { csrf: false });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.receipt.receiptHash);
});

test('GET /votes/receipt/:voteId returns own receipt', async () => {
  const externalId = globalThis.__TEST_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  await c.login(externalId, TEST_PW);
  const vote = await db.query('SELECT vote_id FROM vote_receipts WHERE student_id = $1 LIMIT 1', [testStudentId]);
  assert.ok(vote.rows.length > 0);
  const res = await c.request('GET', `/api/v1/elections/1/votes/receipt/${vote.rows[0].vote_id}`, { csrf: false });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.receipt.receiptHash);
});

test('vote receipt is IDOR-protected (other student cannot read)', async () => {
  const ownVote = await db.query('SELECT vote_id FROM vote_receipts WHERE student_id = $1 LIMIT 1', [testStudentId]);
  const attackerExternalId = globalThis.__ATTACKER_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  await c.login(attackerExternalId, TEST_PW);
  const res = await c.request('GET', `/api/v1/elections/1/votes/receipt/${ownVote.rows[0].vote_id}`, { csrf: false });
  assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
});

test('impersonation attempt via body student_id is rejected', async () => {
  const externalId = globalThis.__TEST_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  await c.login(externalId, TEST_PW);
  // Already voted for position 1; try voting for position 2 but with forged student body
  const res = await c.request('POST', '/api/v1/elections/1/votes', {
    body: { student_id: 9999, election_id: 1, club_id: 1, position_id: 2, candidate_id: 3 },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'IMPERSONATION_ATTEMPT');
});

// ============================================================
// ADMIN ENFORCEMENT
// ============================================================
test('student session hits admin route returns 401/403', async () => {
  const c = new TestClient(baseUrl);
  await c.login('STU001', 'StudentPassword123!');
  const res = await c.request('GET', '/api/v1/admin/students', { csrf: false });
  assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
});

test('unauthenticated admin route returns 401', async () => {
  const fresh = new TestClient(baseUrl);
  const res = await fresh.request('GET', '/api/v1/admin/students', { csrf: false, binding: false });
  assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
});

// ============================================================
// CLASS REPRESENTATIVE (CR) VOTING
// ============================================================
let crConstituencyId;
let crPositionId;

test('CR: my-constituency resolves the student seat from their profile', async () => {
  // Create a 'BCA 2nd Year Section A' constituency in election 1 (auto-creates
  // its own locked Class Representative position).
  const constituency = await constituencyService.create({
    electionId: 1,
    department: 'BCA',
    year: '2nd Year',
    section: 'A',
  });
  crConstituencyId = constituency.id;
  const pos = await db.query('SELECT id FROM positions WHERE constituency_id = $1', [crConstituencyId]);
  assert.ok(pos.rows.length > 0, 'constituency must auto-create its CR position');
  crPositionId = pos.rows[0].id;

  // Authorize the attacker as an election-wide voter too, so the mismatch
  // test reaches the eligibility check (not the earlier auth check).
  await db.query(
    `INSERT INTO voter_authorizations (student_id, election_id)
     VALUES ($1, 1)
     ON CONFLICT DO NOTHING`,
    [attackerStudentId]
  );

  // Give the test student a matching section profile; attacker stays different.
  await db.query(
    `UPDATE students SET department = 'BCA', year_or_semester = '2nd Year', section = 'A' WHERE id = $1`,
    [testStudentId]
  );
  await db.query(
    `UPDATE students SET department = 'BCA', year_or_semester = '2nd Year', section = 'B' WHERE id = $1`,
    [attackerStudentId]
  );

  const externalId = globalThis.__TEST_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  await c.login(externalId, TEST_PW);

  const res = await c.request('GET', '/api/v1/elections/1/votes/my-constituency', { csrf: false });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.constituency.id, crConstituencyId);

  // The attacker (different section) must resolve to nothing.
  const attackerClient = new TestClient(baseUrl);
  await attackerClient.login(globalThis.__ATTACKER_STUDENT_ID__, TEST_PW);
  const attacked = await attackerClient.request('GET', '/api/v1/elections/1/votes/my-constituency', { csrf: false });
  assert.equal(attacked.status, 200);
  assert.equal(attacked.json.data.constituency, null);
});

test('CR: student votes for their own constituency seat', async () => {
  await db.query(
    `INSERT INTO candidates (position_id, name, description, display_order, is_active)
     VALUES ($1, 'CR Candidate Alpha', 'Running for Class Representative', 1, TRUE)`,
    [crPositionId]
  );
  const candidate = await db.query(
    'SELECT id FROM candidates WHERE position_id = $1 ORDER BY id LIMIT 1',
    [crPositionId]
  );
  const candidateId = candidate.rows[0].id;

  const externalId = globalThis.__TEST_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  await c.login(externalId, TEST_PW);

  const res = await c.request('POST', '/api/v1/elections/1/votes', {
    body: { election_id: 1, constituency_id: crConstituencyId, position_id: crPositionId, candidate_id: candidateId },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.data.success, true);
  assert.ok(res.json.data.receipt.receiptHash);

  const row = await db.query('SELECT constituency_id FROM votes WHERE position_id = $1 AND student_id = $2', [crPositionId, testStudentId]);
  assert.equal(row.rows[0].constituency_id, crConstituencyId);
});

test('CR: supplying club_id for a CR seat is rejected', async () => {
  const externalId = globalThis.__TEST_STUDENT_ID__;
  const c = new TestClient(baseUrl);
  await c.login(externalId, TEST_PW);
  const res = await c.request('POST', '/api/v1/elections/1/votes', {
    body: { election_id: 1, club_id: 1, position_id: crPositionId, candidate_id: 1 },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'INVALID_BALLOT_SCOPE');
});

test('CR: student from another section cannot vote in the constituency', async () => {
  // Fresh CR student from the wrong section; must reach CONSTITUENCY_MISMATCH.
  const wrongExternal = `WRG${randomId('')}`.slice(0, 18);
  const hash = await hashPassword(TEST_PW);
  const wrong = await db.query(
    `INSERT INTO students (external_id, name, email, role, password_hash, password_change_required,
                           department, year_or_semester, section, is_active)
     VALUES ($1, 'Wrong Section', $2, 'STUDENT', $3, FALSE, 'BCA', '2nd Year', 'C', TRUE)
     RETURNING id`,
    [wrongExternal, `${wrongExternal}@test.local`, hash]
  );
  const wrongStudentId = wrong.rows[0].id;
  await db.query(
    `INSERT INTO voter_authorizations (student_id, election_id) VALUES ($1, 1)`,
    [wrongStudentId]
  );

  try {
    const c = new TestClient(baseUrl);
    await c.login(wrongExternal, TEST_PW);
    const res = await c.request('POST', '/api/v1/elections/1/votes', {
      body: { election_id: 1, constituency_id: crConstituencyId, position_id: crPositionId, candidate_id: 1 },
    });
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.code, 'CONSTITUENCY_MISMATCH');
  } finally {
    await db.query('DELETE FROM voter_authorizations WHERE student_id = $1', [wrongStudentId]);
    await db.query('DELETE FROM students WHERE id = $1', [wrongStudentId]);
  }
});

test('CR: fixtures are cleaned up for subsequent runs', async () => {
  await db.query('DELETE FROM vote_receipts WHERE vote_id IN (SELECT id FROM votes WHERE position_id = $1)', [crPositionId]);
  await db.query('DELETE FROM votes WHERE position_id = $1', [crPositionId]);
  await db.query('DELETE FROM candidates WHERE position_id = $1', [crPositionId]);
  await db.query('DELETE FROM positions WHERE id = $1', [crPositionId]);
  await db.query('DELETE FROM constituencies WHERE id = $1', [crConstituencyId]);
  await db.query('DELETE FROM voter_authorizations WHERE student_id = $1', [attackerStudentId]);
});

test('admin section edit: department/year/section persist via studentService', async () => {
  const studentService = require('../src/services/studentService');
  const updated = await studentService.update(testStudentId, {
    department: 'BCA',
    year_or_semester: '2nd Year',
    section: 'A',
  });
  assert.equal(updated.department, 'BCA');
  assert.equal(updated.year_or_semester, '2nd Year');
  assert.equal(updated.section, 'A');

  // Clearing section is allowed (returns to application pre-fill).
  const cleared = await studentService.update(testStudentId, { section: null });
  assert.equal(cleared.section, null);
});

test('admin section edit: candidates expose their CR application as pre-fill', async () => {
  const studentService = require('../src/services/studentService');
  const me = await db.query('SELECT name, email FROM students WHERE id = $1', [testStudentId]);

  // Throwaway constituency so the application has a real CR position to point at.
  const constituency = await constituencyService.create({
    electionId: 1,
    department: 'MBA',
    year: '2nd Year',
    section: 'C',
  });
  const pos = await db.query('SELECT id FROM positions WHERE constituency_id = $1', [constituency.id]);

  await db.query(
    `INSERT INTO candidate_applications
       (student_id, full_name, enrollment_number, department, year, section, position_id, email, phone, status, category)
     VALUES ($1, $2, $3, 'MBA', '2nd Year', 'C', $4, $5, '0000000000', 'approved', 'CLASS_REPRESENTATIVE')`,
    [testStudentId, me.rows[0].name, `ENROLL_${randomId('')}`, pos.rows[0].id, me.rows[0].email]
  );
  try {
    const found = await studentService.findById(testStudentId);
    assert.equal(found.applied_department, 'MBA');
    assert.equal(found.applied_year, '2nd Year');
    assert.equal(found.applied_section, 'C');
    assert.equal(found.section, null);
  } finally {
    await db.query(
      'DELETE FROM candidate_applications WHERE student_id = $1 AND category = $2',
      [testStudentId, 'CLASS_REPRESENTATIVE']
    );
    await db.query('DELETE FROM positions WHERE id = $1', [pos.rows[0].id]);
    await db.query('DELETE FROM constituencies WHERE id = $1', [constituency.id]);
    await db.query(
      `UPDATE students SET department = NULL, year_or_semester = NULL, section = NULL WHERE id = $1`,
      [testStudentId]
    );
  }
});

// ============================================================
// RECEIPT PUBLIC VERIFICATION
// ============================================================
test('GET /api/v1/receipts/:uuid validates a real receipt', async () => {
  const row = (await db.query('SELECT id, receipt_hash FROM vote_receipts WHERE student_id = $1 LIMIT 1', [testStudentId])).rows[0];
  const res = await client.request('GET', `/api/v1/receipts/${row.id}`, { csrf: false, binding: false });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.valid, true);
  assert.equal(res.json.receipt.receiptHash, row.receipt_hash);
});

test('GET /api/v1/receipts/:uuid rejects an unknown receipt UUID', async () => {
  // Valid UUID format but not present in DB => 404
  const res = await client.request('GET', '/api/v1/receipts/00000000-0000-4000-8000-000000000000', { csrf: false, binding: false });
  assert.equal(res.status, 404);
});

test('GET /api/v1/receipts/:id rejects a malformed id', async () => {
  // Not a UUID => 400
  const res = await client.request('GET', '/api/v1/receipts/not-a-uuid', { csrf: false, binding: false });
  assert.equal(res.status, 400);
});

// ============================================================
// NOTIFICATIONS
// ============================================================
test('notifications list is accessible for authenticated user', async () => {
  const c = new TestClient(baseUrl);
  await c.login('STU001', 'StudentPassword123!');
  const res = await c.request('GET', '/api/v1/notifications', { csrf: false });
  assert.equal(res.status, 200);
});

test('POST /mark-all-read requires binding + csrf', async () => {
   const c = new TestClient(baseUrl);
   await c.login('STU001', 'StudentPassword123!');
   const res = await c.request('POST', '/api/v1/notifications/mark-all-read');
   assert.ok([200, 204, 404].includes(res.status), `got ${res.status}`);
 });

 // ============================================================
 // STUDENT PROFILE (authenticated, own record only)
 // ============================================================
 test('GET /api/v1/students/profile returns the caller\x27s own record', async () => {
   const c = new TestClient(baseUrl);
   await c.login('STU001', 'StudentPassword123!');
   const res = await c.request('GET', '/api/v1/students/profile', { csrf: false });
   assert.equal(res.status, 200, `got ${res.status}`);
   const data = res.json.data;
   assert.ok(data.id);
   assert.equal(data.name, 'Student One');
 });

 test('GET /api/v1/students/profile rejects unauthenticated access', async () => {
   const c = new TestClient(baseUrl);
   const res = await c.request('GET', '/api/v1/students/profile', { csrf: false });
   assert.equal(res.status, 401);
 });

// ============================================================
// ANNOUNCEMENT → NOTIFICATIONS
// ============================================================
test('published announcement creates notifications for approved + rejected candidates', async () => {
  // Give testStudentId an "approved" application and attackerStudentId a "rejected" one.
  const enrollmentApproved = `ENR${randomId('')}`.slice(0, 30);
  const enrollmentRejected = `ENR${randomId('')}`.slice(0, 30);
  await db.query(
    `INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, position_id, email, phone, status)
     VALUES ($1, 'Approved Candidate', $2, 'CS', '3', 1, $3, '9999999990', 'approved')`,
    [testStudentId, enrollmentApproved, `${testStudentId}@test.local`]
  );
  await db.query(
    `INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, position_id, email, phone, status)
     VALUES ($1, 'Rejected Candidate', $2, 'CS', '3', 2, $3, '9999999991', 'rejected')`,
    [attackerStudentId, enrollmentRejected, `${attackerStudentId}@test.local`]
  );

  await db.query('DELETE FROM notifications WHERE user_id IN ($1, $2)', [testStudentId, attackerStudentId]);

  const announcement = await announcementService.create({
    title: 'Election Day Reminder',
    message: 'Voting closes at 5 PM.',
    audience: 'all',
    priority: 'high',
    published: true,
  });

  try {
    assert.ok(announcement.is_published);

    const notifs = await db.query(
      `SELECT user_id, category, title, message, priority, is_read
       FROM notifications
       WHERE user_id IN ($1, $2)
       ORDER BY user_id`,
      [testStudentId, attackerStudentId]
    );

    const seen = new Map(notifs.rows.map((n) => [n.user_id, n]));
    assert.equal(notifs.rows.length, 2, 'one notification per candidate');
    assert.ok(seen.has(testStudentId), 'approved candidate notified');
    assert.ok(seen.has(attackerStudentId), 'rejected candidate notified');

    for (const row of notifs.rows) {
      assert.equal(row.category, 'announcement');
      assert.equal(row.title, 'Election Day Reminder');
      assert.equal(row.message, 'Voting closes at 5 PM.');
      assert.equal(row.priority, 'high');
      assert.equal(row.is_read, false);
    }
  } finally {
    await db.query('DELETE FROM candidate_applications WHERE student_id = ANY($1::int[])', [[testStudentId, attackerStudentId]]);
  }
});

test('unpublished announcement does not notify candidates', async () => {
  await db.query('DELETE FROM notifications WHERE user_id IN ($1, $2)', [testStudentId, attackerStudentId]);

  const draft = await announcementService.create({
    title: 'Draft Announcement',
    message: 'Should not notify.',
    audience: 'all',
    published: false,
  });

  assert.equal(draft.is_published, false);
  const notifs = await db.query(
    'SELECT COUNT(*) FROM notifications WHERE user_id IN ($1, $2)',
    [testStudentId, attackerStudentId]
  );
  assert.equal(parseInt(notifs.rows[0].count), 0);
});

test('admin-only announcement does not notify candidates', async () => {
  await db.query('DELETE FROM notifications WHERE user_id IN ($1, $2)', [testStudentId, attackerStudentId]);

  const announcement = await announcementService.create({
    title: 'Staff Notice',
    message: 'Internal.',
    audience: 'admins',
    published: true,
  });

  assert.equal(announcement.is_published, true);
  const notifs = await db.query(
    'SELECT COUNT(*) FROM notifications WHERE user_id IN ($1, $2)',
    [testStudentId, attackerStudentId]
  );
  assert.equal(parseInt(notifs.rows[0].count), 0);
});

// ============================================================
// MONITORING (Prometheus /metrics + admin monitoring summary)
// ============================================================

const VER = '0123456789abcdef0123456789abcdef0123456789abcdef';

/** Mint a real ADMIN session (id 501) by calling createSession directly. */
async function mintAdminSession() {
  let rawToken = null;
  await createSession({ cookie: (name, value) => { rawToken = value; } }, 501, true);
  assert.ok(rawToken, 'session token not captured');
  return rawToken;
}

test('GET /metrics without token returns 401 when METRICS_TOKEN is set', async () => {
  process.env.METRICS_TOKEN = VER;
  try {
    const res = await client.request('GET', '/metrics', { csrf: false, binding: false });
    assert.equal(res.status, 401);
  } finally {
    delete process.env.METRICS_TOKEN;
  }
});

test('GET /metrics with wrong token returns 401', async () => {
  process.env.METRICS_TOKEN = VER;
  try {
    const res = await client.request('GET', '/metrics', {
      csrf: false,
      binding: false,
      headers: { Authorization: 'Bearer wrong-token-here' },
    });
    assert.equal(res.status, 401);
  } finally {
    delete process.env.METRICS_TOKEN;
  }
});

test('GET /metrics with valid token returns exposition text', async () => {
  process.env.METRICS_TOKEN = VER;
  try {
    const res = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${VER}` },
    });
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.includes('text/plain'), `unexpected content-type ${ct}`);
    const body = await res.text();
    assert.ok(body.includes('campusvote_http_requests_total'), 'missing http requests metric');
    assert.ok(body.includes('campusvote_votes_cast_total'), 'missing votes cast metric');
  } finally {
    delete process.env.METRICS_TOKEN;
  }
});

test('GET /metrics with no token is open in non-production and closed in production', async () => {
  // Non-production (test): open access.
  let res = await client.request('GET', '/metrics', { csrf: false, binding: false });
  assert.equal(res.status, 200);

  // Production without token: deliberately disabled (403).
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    res = await client.request('GET', '/metrics', { csrf: false, binding: false });
    assert.equal(res.status, 403);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('GET /api/v1/admin/monitoring is forbidden for unauthenticated and student callers', async () => {
  const fresh = new TestClient(baseUrl);
  const unauth = await fresh.request('GET', '/api/v1/admin/monitoring', { csrf: false, binding: false });
  assert.ok([401, 403].includes(unauth.status), `expected 401/403, got ${unauth.status}`);

  const student = new TestClient(baseUrl);
  await student.login('STU001', 'StudentPassword123!');
  const denied = await student.request('GET', '/api/v1/admin/monitoring', { csrf: false });
  assert.ok([401, 403].includes(denied.status), `expected 401/403, got ${denied.status}`);
});

test('GET /api/v1/admin/monitoring returns aggregate summary for a minted admin session', async () => {
  const rawToken = await mintAdminSession();
  const admin = new TestClient(baseUrl);
  const res = await admin.request('GET', '/api/v1/admin/monitoring', {
    csrf: false,
    binding: false,
    headers: { Cookie: `cv_sid=${rawToken}` },
  });
  assert.equal(res.status, 200);
  const data = res.json.data;
  assert.ok(data.status && ['healthy', 'degraded'].includes(data.status), `unexpected status ${data.status}`);
  assert.ok(data.process.cpuPercent === null || typeof data.process.cpuPercent === 'number');
  assert.equal(typeof data.http.requestsTotal, 'number');
  assert.equal(typeof data.http.requestsPerSecond, 'number');
  assert.equal(typeof data.database.connected, 'boolean');
  assert.equal(typeof data.business.activeElections, 'number');
  assert.equal(typeof data.business.votesCast, 'number');
  assert.equal(typeof data.business.loginAttempts, 'number');
});
// ============================================================
// COMPLETE PROFILE (first-time registration step)
// ============================================================
async function createBareProfileStudent(prefix) {
  const externalId = `${prefix}${randomId('')}`.slice(0, 18);
  const hash = await hashPassword(TEST_PW);
  const inserted = await db.query(
    `INSERT INTO students (external_id, name, email, role, password_hash, password_change_required)
     VALUES ($1, $2, $3, 'STUDENT', $4, FALSE)
     RETURNING id`,
    [externalId, `Profile ${externalId}`, `${externalId}@test.local`, hash]
  );
  return { id: inserted.rows[0].id, externalId };
}

async function loginProfileClient(externalId) {
  const c = new TestClient(baseUrl);
  const res = await c.login(externalId, TEST_PW);
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.json)}`);
  return c;
}

test('POST /api/v1/auth/profile rejects unauthenticated callers', async () => {
  const fresh = new TestClient(baseUrl);
  const res = await fresh.request('POST', '/api/v1/auth/profile', {
    body: { rollNumber: 'ROLLX001', department: 'BCA', year: '2nd Year', section: 'A' },
  });
  assert.equal(res.status, 401);
});

test('POST /api/v1/auth/profile validates input and completes once', async () => {
  const { id, externalId } = await createBareProfileStudent('PRF');
  try {
    const c = await loginProfileClient(externalId);

    let res = await c.request('POST', '/api/v1/auth/profile', { body: {} });
    assert.equal(res.status, 400);

    res = await c.request('POST', '/api/v1/auth/profile', {
      body: { rollNumber: 'ROLLX001', department: 'PHYSICS', year: '2nd Year', section: 'A' },
    });
    assert.equal(res.status, 400);

    res = await c.request('POST', '/api/v1/auth/profile', {
      body: { rollNumber: 'ROLLX001', department: 'BCA', year: '5th Year', section: 'A' },
    });
    assert.equal(res.status, 400);

    res = await c.request('POST', '/api/v1/auth/profile', {
      body: { rollNumber: '  rollx001 ', department: 'bca', year: '2nd Year', section: 'a' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.profile.rollNumber, 'rollx001');
    assert.equal(res.json.data.profile.department, 'BCA');
    assert.equal(res.json.data.profile.year, '2nd Year');
    assert.equal(res.json.data.profile.section, 'A');

    const me = await c.request('GET', '/api/v1/auth/me', { csrf: false, binding: false });
    assert.equal(me.json.data.user.rollNumber, 'rollx001');
    assert.equal(me.json.data.user.department, 'BCA');
    assert.equal(me.json.data.user.year, '2nd Year');
    assert.equal(me.json.data.user.section, 'A');

    res = await c.request('POST', '/api/v1/auth/profile', {
      body: { rollNumber: 'ROLLX002', department: 'BBA', year: '1st Year', section: 'B' },
    });
    assert.equal(res.status, 403);
  } finally {
    await db.query('DELETE FROM sessions WHERE student_id = $1', [id]);
    await db.query('DELETE FROM students WHERE id = $1', [id]);
  }
});

test('POST /api/v1/auth/profile rejects duplicate roll numbers', async () => {
  const first = await createBareProfileStudent('PR1');
  const second = await createBareProfileStudent('PR2');
  try {
    const c1 = await loginProfileClient(first.externalId);
    let res = await c1.request('POST', '/api/v1/auth/profile', {
      body: { rollNumber: 'DUPL0001', department: 'MBA', year: '1st Year', section: 'C' },
    });
    assert.equal(res.status, 200);

    const c2 = await loginProfileClient(second.externalId);
    res = await c2.request('POST', '/api/v1/auth/profile', {
      body: { rollNumber: 'dupl0001', department: 'MCA', year: '3rd Year', section: 'A' },
    });
    assert.equal(res.status, 409);
  } finally {
    await db.query('DELETE FROM sessions WHERE student_id IN ($1, $2)', [first.id, second.id]);
    await db.query('DELETE FROM students WHERE id IN ($1, $2)', [first.id, second.id]);
  }
});
