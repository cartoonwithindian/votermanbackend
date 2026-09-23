/**
 * Ballot chain integration tests: atomic ballot submission plus the
 * class-scoping rules that must hold across the whole vote path.
 *
 * Runs against the disposable PostgreSQL test database, booting the real
 * app on an ephemeral port. It creates its OWN election + students so it
 * never collides with the fixtures used by api.test.js / verify*.test.js
 * (which run in parallel child processes sharing the same DB).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://voteweb:voteweb@localhost:5434/voteweb';

// Many HTTP vote calls happen in this file within one wall-clock minute;
// raise the per-minute vote limiter so the suite is not rate-limited.
process.env.VOTE_LIMIT_MAX = process.env.TEST_VOTE_LIMIT_MAX || '200';

const app = require('../src/app');
const db = require('../src/db');
const { hashPassword } = require('../src/lib/password');
const { TestClient } = require('./helpers');
const electionService = require('../src/services/electionService');
const constituencyService = require('../src/services/constituencyService');

const PW = 'BallotPassword123!';

let server;
let baseUrl;
let electionId;
let constA; // BCA 1st Year Section A
let constB; // BCA 1st Year Section B
let constC; // MCA 1st Year (section-less)
let constD; // BCA 1st Year Section C — left closed (voting_open false)
let posABoys;
let posAGirls;
let posBBoys;
let posCGirls;
let posDBoys;
let candABoys;
let candAGirls;
let candBBoys;
let candCGirls;
let candDBoys;

let studentA; // BCA 1st Year A        (eligible)
let studentB; // BCA 1st Year B        (eligible)
let studentC; // MCA 1st Year          (eligible)
let studentD; // BCA 1st Year C        (eligible, class NOT started)
let studentIneligible; // same class as A, no authorization

async function insertStudent({ externalId, name, department, year, section, email, votingEligible = true }) {
  const hash = await hashPassword(PW);
  const row = await db.query(
    `INSERT INTO students (external_id, name, email, role, password_hash, password_change_required,
                           department, year_or_semester, section, voting_eligible, is_active)
     VALUES ($1, $2, $3, 'STUDENT', $4, FALSE, $5, $6, $7, $8, TRUE)
     RETURNING id`,
    [externalId, name, email, hash, department, year, section, votingEligible]
  );
  return row.rows[0].id;
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Own isolated election, opened so votes are accepted.
  const election = await electionService.create({
    name: 'BALLOT_CHAIN_TEST',
    description: 'ballot chain verification election',
  });
  electionId = election.id;
  await electionService.updateStatus(electionId, 'OPEN');

  const mkConst = (suite, department, year, section) =>
    constituencyService.create({ electionId, department, year, section });

  constA = await mkConst('A', 'BCA', '1st Year', 'A');
  constB = await mkConst('B', 'BCA', '1st Year', 'B');
  constC = await mkConst('C', 'MCA', '1st Year', '');
  constD = await mkConst('D', 'BCA', '1st Year', 'C');

  // Classes start closed by default. Open the ones the suite votes in.
  for (const c of [constA, constB, constC]) {
    await constituencyService.update(c.id, { voting_open: true });
  }

  const posOf = async (constituencyId, genderName) => {
    const { rows } = await db.query(
      'SELECT id FROM positions WHERE constituency_id = $1 AND name ILIKE $2 ORDER BY id LIMIT 1',
      [constituencyId, `%${genderName}%`]
    );
    return rows[0].id;
  };

  posABoys = await posOf(constA.id, 'Boys');
  posAGirls = await posOf(constA.id, 'Girls');
  posBBoys = await posOf(constB.id, 'Boys');
  posCGirls = await posOf(constC.id, 'Girls');
  posDBoys = await posOf(constD.id, 'Boys');

  const insertCand = async (positionId, name) => {
    const { rows } = await db.query(
      `INSERT INTO candidates (position_id, name, description, display_order, is_active)
       VALUES ($1, $2, 'test candidate', 1, TRUE) RETURNING id`,
      [positionId, name]
    );
    return rows[0].id;
  };

  candABoys = await insertCand(posABoys, 'Balanced Boy A');
  candAGirls = await insertCand(posAGirls, 'Eligible Girl A');
  candBBoys = await insertCand(posBBoys, 'Other Section Boy B');
  candCGirls = await insertCand(posCGirls, 'Sectionless Girl C');
  candDBoys = await insertCand(posDBoys, 'Closed Class Boy D');

  studentA = await insertStudent({
    externalId: 'BAL_A',
    name: 'Ballet A',
    department: 'BCA',
    year: '1st Year',
    section: 'A',
    email: 'bal_a@ballot.local',
  });
  studentB = await insertStudent({
    externalId: 'BAL_B',
    name: 'Ballet B',
    department: 'BCA',
    year: '1st Year',
    section: 'B',
    email: 'bal_b@ballot.local',
  });
  studentC = await insertStudent({
    externalId: 'BAL_C',
    name: 'Ballet C',
    department: 'MCA',
    year: '1st Year',
    section: '',
    email: 'bal_c@ballot.local',
  });
  studentD = await insertStudent({
    externalId: 'BAL_D',
    name: 'Ballet D',
    department: 'BCA',
    year: '1st Year',
    section: 'C',
    email: 'bal_d@ballot.local',
  });
  studentIneligible = await insertStudent({
    externalId: 'BAL_X',
    name: 'Ballet X',
    department: 'BCA',
    year: '1st Year',
    section: 'A',
    email: 'bal_x@ballot.local',
    votingEligible: false,
  });

  const grant = async (studentId) => {
    await db.query(
      'INSERT INTO voter_authorizations (student_id, election_id) VALUES ($1, $2)',
      [studentId, electionId]
    );
  };

  await grant(studentA);
  await grant(studentB);
  await grant(studentC);
  // studentD is eligible: authorization not needed (voting_eligible auto-grants).
  // studentIneligible intentionally has no authorization.
});

test.after(async () => {
  const clean = async (studentId) => {
    await db.query('DELETE FROM vote_receipts WHERE student_id = $1', [studentId]);
    await db.query('DELETE FROM votes WHERE student_id = $1', [studentId]);
    await db.query('DELETE FROM voter_authorizations WHERE student_id = $1', [studentId]);
    await db.query('DELETE FROM sessions WHERE student_id = $1', [studentId]);
    await db.query('DELETE FROM students WHERE id = $1', [studentId]);
  };
  for (const s of [studentA, studentB, studentC, studentD, studentIneligible]) {
    await clean(s);
  }
  await db.query(
    `DELETE FROM candidates WHERE position_id IN (
       SELECT p.id FROM positions p JOIN constituencies ct ON p.constituency_id = ct.id
       WHERE ct.election_id = $1)`,
    [electionId]
  );
  await db.query(
    `DELETE FROM positions WHERE constituency_id IN (
       SELECT id FROM constituencies WHERE election_id = $1)`,
    [electionId]
  );
  await db.query('DELETE FROM constituencies WHERE election_id = $1', [electionId]);
  await db.query('DELETE FROM elections WHERE id = $1', [electionId]);
  server.close();
  await db.close();
});

async function loginAs(studentId) {
  const { rows } = await db.query('SELECT external_id FROM students WHERE id = $1', [studentId]);
  const c = new TestClient(baseUrl);
  const login = await c.login(rows[0].external_id, PW);
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return c;
}

async function countVotes(studentId) {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM votes WHERE student_id = $1', [studentId]);
  return parseInt(rows[0].n, 10);
}

// ------------------------------------------------------------------
// 1. Single-class election: a student's ballot has both CR seats.
// ------------------------------------------------------------------
test('single-class ballot: own class resolves and both CR seats are voteable', async () => {
  const c = await loginAs(studentA);
  const res = await c.request('GET', `/api/v1/elections/${electionId}/votes/my-constituency`, { csrf: false });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(String(res.json.data.constituency.id), String(constA.id));
  const { rows } = await db.query(
    'SELECT id, name FROM positions WHERE constituency_id = $1 AND is_active = true ORDER BY id',
    [constA.id]
  );
  assert.equal(rows.length, 2, 'two CR seats auto-created');
  assert.ok(rows.some((r) => /Boy/i.test(r.name)));
  assert.ok(rows.some((r) => /Girl/i.test(r.name)));
});

// ------------------------------------------------------------------
// 2. Two-class ballot: each class sees only its own positions.
// ------------------------------------------------------------------
test('two-class ballot: BCA-A sees only BCA-A positions', async () => {
  const { rows } = await db.query(
    `SELECT p.id FROM positions p JOIN constituencies ct ON p.constituency_id = ct.id
     WHERE ct.election_id = $1`,
    [electionId]
  );
  const allPositions = rows.map((r) => Number(r.id));
  assert.ok(allPositions.includes(Number(posABoys)));
  assert.ok(allPositions.includes(Number(posBBoys)));

  const awayCandidates = await db.query(
    `SELECT id FROM candidates WHERE position_id = $1`,
    [posBBoys]
  );
  const c = await loginAs(studentA);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes/ballot`, {
    body: {
      constituency_id: constA.id,
      selections: [
        { positionId: posABoys, candidateId: candABoys },
        { positionId: posAGirls, candidateId: candAGirls },
        { positionId: posBBoys, candidateId: awayCandidates.rows[0].id },
      ],
    },
  });
  assert.notEqual(res.status, 201, JSON.stringify(res.json));
  assert.equal(await countVotes(studentA), 0, 'a seat from another class must not be accepted in the ballot');
});

// ------------------------------------------------------------------
// 3. Ballot isolation 1A vs 1B: same dept+year, different section.
// ------------------------------------------------------------------
test('ballot isolation 1A vs 1B: cannot vote the other section seat', async () => {
  const c = await loginAs(studentB);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes`, {
    body: { election_id: electionId, constituency_id: constA.id, position_id: posABoys, candidate_id: candABoys },
  });
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.equal(res.json.code, 'CONSTITUENCY_MISMATCH');
});

// ------------------------------------------------------------------
// 4. Cross-class candidate rejected (candidate from another class).
// ------------------------------------------------------------------
test('cross-class candidate rejected via alternating seat', async () => {
  const c = await loginAs(studentC);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes`, {
    body: { election_id: electionId, constituency_id: constC.id, position_id: posCGirls, candidate_id: candABoys },
  });
  assert.equal(res.status, 404, JSON.stringify(res.json));
  assert.equal(res.json.code, 'CANDIDATE_NOT_FOUND');
});

// ------------------------------------------------------------------
// 5. Cross-class position rejected (position owned by another class).
// ------------------------------------------------------------------
test('cross-class position rejected', async () => {
  const c = await loginAs(studentB);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes`, {
    body: { election_id: electionId, constituency_id: constB.id, position_id: posABoys, candidate_id: candBBoys },
  });
  assert.equal(res.status, 404, JSON.stringify(res.json));
  assert.equal(res.json.code, 'CONSTITUENCY_NOT_FOUND');
});

// ------------------------------------------------------------------
// 6. Manual constituency_id change rejected (must match session class).
// ------------------------------------------------------------------
test('manual constituency change rejected with CONSTITUENCY_MISMATCH', async () => {
  const c = await loginAs(studentA);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes`, {
    body: { election_id: electionId, constituency_id: constB.id, position_id: posBBoys, candidate_id: candBBoys },
  });
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.equal(res.json.code, 'CONSTITUENCY_MISMATCH');
});

// ------------------------------------------------------------------
// 7. Spoofed student_id in body rejected.
// ------------------------------------------------------------------
test('spoofed student_id is rejected (session identity wins)', async () => {
  const c = await loginAs(studentA);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes`, {
    body: { student_id: 999999, election_id: electionId, constituency_id: constA.id, position_id: posABoys, candidate_id: candABoys },
  });
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.equal(res.json.code, 'IMPERSONATION_ATTEMPT');
});

// ------------------------------------------------------------------
// 8. Ineligible student (no grant) rejected.
// ------------------------------------------------------------------
test('ineligible student cannot vote', async () => {
  const c = await loginAs(studentIneligible);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes`, {
    body: { election_id: electionId, constituency_id: constA.id, position_id: posABoys, candidate_id: candABoys },
  });
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.equal(res.json.code, 'NOT_AUTHORIZED');
});

// ------------------------------------------------------------------
// 9. Double-vote race: one 409, previous ballot intact, nothing new.
// ------------------------------------------------------------------
test('double-vote on same position rejected with 409 and one vote stored', async () => {
  const c = await loginAs(studentC);
  const first = await c.request('POST', `/api/v1/elections/${electionId}/votes/ballot`, {
    body: {
      constituency_id: constC.id,
      selections: [
        { positionId: posCGirls, candidateId: candCGirls },
      ],
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));

  const second = await c.request('POST', `/api/v1/elections/${electionId}/votes/ballot`, {
    body: {
      constituency_id: constC.id,
      selections: [
        { positionId: posCGirls, candidateId: candCGirls },
      ],
    },
  });
  assert.equal(second.status, 409, JSON.stringify(second.json));
  assert.equal(second.json.code, 'ALREADY_VOTED');
  assert.equal(await countVotes(studentC), 1);
});

// ------------------------------------------------------------------
// 10. Atomic ballot: a bad second selection stores nothing (rollback).
// ------------------------------------------------------------------
test('atomic ballot rollback: invalid second selection leaves zero votes', async () => {
  const c = await loginAs(studentB);
  const before = await countVotes(studentB);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes/ballot`, {
    body: {
      constituency_id: constB.id,
      selections: [
        { positionId: posBBoys, candidateId: candBBoys },
        { positionId: posAGirls, candidateId: candAGirls },
      ],
    },
  });
  assert.notEqual(res.status, 201, JSON.stringify(res.json));
  assert.equal(await countVotes(studentB), before, 'second-selection failure must not persist the first');
});

// ------------------------------------------------------------------
// 11. Atomic ballot: duplicate position in one request rejected.
// ------------------------------------------------------------------
test('atomic ballot rejects two selections for the same position', async () => {
  const c = await loginAs(studentA);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes/ballot`, {
    body: {
      constituency_id: constA.id,
      selections: [
        { positionId: posABoys, candidateId: candABoys },
        { positionId: posABoys, candidateId: candABoys },
      ],
    },
  });
  assert.equal(res.status, 422, JSON.stringify(res.json));
  assert.equal(res.json.code, 'INVALID_BALLOT');
});

// ------------------------------------------------------------------
// 12. Valid ballot persists every selection + receipts atomically.
// ------------------------------------------------------------------
test('valid ballot stores all selections and receipts', async () => {
  const c = await loginAs(studentA);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes/ballot`, {
    body: {
      constituency_id: constA.id,
      selections: [
        { positionId: posABoys, candidateId: candABoys },
        { positionId: posAGirls, candidateId: candAGirls },
      ],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.data.count, 2);
  assert.equal(res.json.data.receipts.length, 2);
  assert.equal(await countVotes(studentA), 2, 'both selections stored');
});

// ------------------------------------------------------------------
// 13. Closed class: voting_open=false rejects votes (CLASS_NOT_OPEN).
// ------------------------------------------------------------------
test('closed class (voting_open=false) rejects votes with CLASS_NOT_OPEN', async () => {
  const c = await loginAs(studentD);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes`, {
    body: { election_id: electionId, constituency_id: constD.id, position_id: posDBoys, candidate_id: candDBoys },
  });
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.equal(res.json.code, 'CLASS_NOT_OPEN');
  assert.equal(await countVotes(studentD), 0);
});

// ------------------------------------------------------------------
// 14. Admin toggle: opening the class (voting_open=true) permits voting.
// ------------------------------------------------------------------
test('admin opens a class (voting_open=true) then votes are accepted', async () => {
  await constituencyService.update(constD.id, { voting_open: true });
  const c = await loginAs(studentD);
  const res = await c.request('POST', `/api/v1/elections/${electionId}/votes`, {
    body: { election_id: electionId, constituency_id: constD.id, position_id: posDBoys, candidate_id: candDBoys },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(await countVotes(studentD), 1);
});

// ------------------------------------------------------------------
// 15. Election results join through the hierarchy (per-class counts).
// ------------------------------------------------------------------
test('results join candidates/positions/constituencies for the election', async () => {
  const { getElectionResults } = require('../src/services/voteService');
  const results = await getElectionResults(electionId);
  assert.ok(Array.isArray(results), 'results is an array');
  assert.ok(results.length >= 1, 'results include the cast votes');
  const row = results.find((r) => Number(r.candidate_id) === Number(candABoys));
  assert.ok(row, 'A-Boys candidate present in results');
  assert.equal(String(row.constituency_id), String(constA.id));
  assert.equal(String(row.position_id), String(posABoys));
  assert.ok(row.candidate_name, 'joined candidate name present');
});