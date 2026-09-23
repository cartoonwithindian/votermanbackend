/**
 * Temporary verification: real end-to-end class-based election setup.
 * Runs the actual services (electionService, constituencyService,
 * positionService, candidateService, masterCandidateMatcher) against the
 * live test PostgreSQL and asserts the full checklist.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://voteweb:voteweb@localhost:5434/voteweb';

const db = require('../src/db');
const electionService = require('../src/services/electionService');
const masterCandidateMatcher = require('../src/services/masterCandidateMatcher');
const positionService = require('../src/services/positionService');
const candidateService = require('../src/services/candidateService');

// Net inserted into the isolated election's constituency
async function countCandidatesElection(electionId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM candidates c
     JOIN positions p ON c.position_id = p.id
     JOIN constituencies ct ON p.constituency_id = ct.id
     WHERE ct.election_id = $1`,
    [electionId]
  );
  return parseInt(rows[0].n, 10);
}

async function countPositionsConstituency(constituencyId) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM positions WHERE constituency_id = $1',
    [constituencyId]
  );
  return parseInt(rows[0].n, 10);
}

async function waitForInvalidation() {
  await new Promise((r) => setTimeout(r, 60));
}

test('masterCandidateMatcher: end-to-end class setup', async () => {
  const election = await electionService.create({
    name: 'VOTEWEB_VERIFY_TEMP',
    description: 'temporary verification',
  });
  const electionId = election.id;
  assert.ok(electionId, 'election created');

  try {
    // --- Class 1: BCA 1st Year A2 (6 candidates in master file) ---
    const c1 = { department: 'BCA', year: '1st Year', section: 'A2' };
    const out1 = await masterCandidateMatcher.matchClassForElection(electionId, c1);
    assert.ok(out1.constituency, 'constituency created for BCA 1st Year A2');
    assert.ok(out1.constituency.id, 'constituency has id');
    assert.equal(out1.placed.length, 6, '6 master candidates placed');
    assert.equal(await countPositionsConstituency(out1.constituency.id), 2, 'two CR seats created');
    assert.equal(await countCandidatesElection(electionId), 6, '6 candidates net in election');

    // --- Idempotency: re-running must NOT duplicate anything ---
    const out1b = await masterCandidateMatcher.matchClassForElection(electionId, c1);
    assert.equal(out1b.placed.length, 0, 'no duplicates on re-run');
    assert.equal(out1b.skipped.filter((s) => s.reason === 'already on ballot').length, 6, 'all 6 skipped as already-on-ballot');
    assert.equal(await countCandidatesElection(electionId), 6, 'still 6 candidates after re-run');
    await waitForInvalidation();

    // --- Seat gender assignment vs declared position hint ---
    const positions1 = await positionService.findByConstituencyId(out1.constituency.id);
    const boys = positions1.find((p) => /Boy/i.test(p.name));
    const girls = positions1.find((p) => /Girl/i.test(p.name));
    assert.ok(boys && girls, 'both Boys and Girls seats exist');
    const { rows: placed1 } = await db.query(
      `SELECT c.name, c.position_id FROM candidates c
       JOIN positions p ON c.position_id = p.id
       JOIN constituencies ct ON p.constituency_id = ct.id
       WHERE ct.id = $1`,
      [out1.constituency.id]
    );
    for (const row of placed1) {
      assert.ok(row.position_id === boys.id || row.position_id === girls.id, 'candidate on a valid seat');
    }
    assert.equal(placed1.filter((r) => r.position_id === boys.id).length, 3, '3 on boys seat');
    assert.equal(placed1.filter((r) => r.position_id === girls.id).length, 3, '3 on girls seat');

    // --- Class 2: MBA 2nd Year (sectionless, 2 candidates) ---
    const c2 = { department: 'MBA', year: '2nd Year', section: '' };
    const out2 = await masterCandidateMatcher.matchClassForElection(electionId, c2);
    assert.ok(out2.constituency, 'constituency created for MBA 2nd Year');
    assert.equal(out2.placed.length, 2, '2 master candidates placed');
    assert.equal(await countPositionsConstituency(out2.constituency.id), 2, 'two CR seats for MBA');
    assert.equal(await countCandidatesElection(electionId), 8, '8 candidates total across both classes');
    await waitForInvalidation();

    // --- Class 3: BBA 1st Year A1 (3 boys, 0 girls) — single-gender spread.
    // Boys must tile across BOTH seats so the class has two CRs, rather than
    // piling all three onto the Boys seat and leaving Girls empty. ---
    const c3 = { department: 'BBA', year: '1st Year', section: 'A1' };
    const out3 = await masterCandidateMatcher.matchClassForElection(electionId, c3);
    assert.ok(out3.constituency, 'constituency created for BBA 1st Year A1');
    assert.equal(out3.placed.length, 3, '3 master candidates placed');
    const positions3 = await positionService.findByConstituencyId(out3.constituency.id);
    const boys3 = positions3.find((p) => /Boy/i.test(p.name));
    const girls3 = positions3.find((p) => /Girl/i.test(p.name));
    assert.ok(boys3 && girls3, 'both seats exist for single-gender class');
    const { rows: placed3 } = await db.query(
      `SELECT c.name, c.position_id FROM candidates c
       JOIN positions p ON c.position_id = p.id
       JOIN constituencies ct ON p.constituency_id = ct.id
       WHERE ct.id = $1`,
      [out3.constituency.id]
    );
    assert.ok(
      placed3.some((r) => r.position_id === boys3.id) && placed3.some((r) => r.position_id === girls3.id),
      'boys spread onto BOTH seats'
    );
    assert.equal(await countCandidatesElection(electionId), 11, '11 candidates total across three classes');
    await waitForInvalidation();

    // --- Election isolation: must not touch other elections (fixture election 1) ---
    const { rows: other } = await db.query(
      `SELECT COUNT(*) AS n FROM candidates c
       JOIN positions p ON c.position_id = p.id
       JOIN constituencies ct ON p.constituency_id = ct.id
       WHERE ct.election_id = 1`,
      []
    );
    assert.equal(parseInt(other[0].n, 10), 4, 'fixture election 1 still has its 4 candidates');

    // --- Close election = status flip only, nothing deleted ---
    const opened = await electionService.updateStatus(electionId, 'OPEN');
    assert.equal(opened.election.status, 'OPEN');
    const closed = await electionService.updateStatus(electionId, 'CLOSED');
    assert.equal(closed.election.status, 'CLOSED');
    assert.equal(await countCandidatesElection(electionId), 11, 'candidates intact after close');
    const closedElection = await electionService.findById(electionId);
    assert.equal(closedElection.status, 'CLOSED');
  } finally {
    // Cleanup the temp election tree (children -> parents)
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
  }
});

test.after(async () => {
  await db.close();
});