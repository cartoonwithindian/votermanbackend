const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://voteweb:voteweb@localhost:5434/voteweb';

const db = require('../src/db');
const electionService = require('../src/services/electionService');
const masterCandidateMatcher = require('../src/services/masterCandidateMatcher');

test('zero-candidate class still gets two empty CR seats', async () => {
  const election = await electionService.create({ name: 'VOTEWEB_VERIFY_ZERO', description: 'temp' });
  const electionId = election.id;
  try {
    // BCom 3rd Year has no candidates in the 66-master file
    const out = await masterCandidateMatcher.matchClassForElection(electionId, {
      department: 'BCom',
      year: '3rd Year',
      section: '',
    });
    assert.ok(out.constituency, 'constituency created for empty class');
    assert.equal(out.placed.length, 0, 'no candidates placed');
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM positions WHERE constituency_id = $1',
      [out.constituency.id]
    );
    assert.equal(parseInt(rows[0].n, 10), 2, 'two empty CR seats exist');
  } finally {
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