/**
 * Master Candidate Matcher
 *
 * Auto-matches master candidates (data/candidates.json) to a class
 * (constituency) inside an election. Once a class is added to an election
 * its two CR seats exist but sit empty; calling matchClassForElection fills
 * those seats from the master candidate DB.
 *
 * Rules:
 *  - Matching is department + year/semester (normalized) + section only.
 *  - Seat selection is gender-preferring but NOT gender-required (see
 *    pickCrSeat): a same-gender pair or gender-less candidate still gets a
 *    deterministic seat.
 *  - Existing candidates on the seat are never replaced/overwritten; a
 *    candidate already on the same seat is skipped as a duplicate. A master
 *    candidate keeps ONE canonical ballot doc: later elections LINK to it
 *    (linked_positions) instead of cloning it.
 *  - Never deletes, never moves, never touches other elections.
 */

const jsonStore = require('./jsonCandidateStore');
const constituencyService = require('./constituencyService');
const positionService = require('./positionService');
const candidateService = require('./candidateService');
const { normalizeYear } = require('../utils/yearNormalizer');
const { normalizeDepartment, normalizeSection } = require('../utils/classList');
const { getDb: getSharedDb } = require('../db/mongoClient');
const { pickCrSeat, isSingleGenderClass } = require('../utils/crSeat');

const SECTIONLESS = ['MBA', 'MCA', 'BCom'];

function sourceSection(cand) {
  const raw = cand.section ?? cand.Section ?? '';
  return normalizeSection(raw);
}

function sourceDepartment(cand) {
  return normalizeDepartment(cand.department ?? cand.Department ?? '');
}

function sourceYear(cand) {
  return normalizeYear(cand.year ?? cand.Year) || '';
}

/**
 * Find the master candidates that belong to one class.
 * @returns {Array} master candidate objects
 */
function candidatesForClass(masterCandidates, { department, year, section }) {
  const dept = normalizeDepartment(department);
  const y = normalizeYear(year) || '';
  const sec = normalizeSection(section);
  if (!dept || !y) return [];
  return (Array.isArray(masterCandidates) ? masterCandidates : []).filter((cand) => {
    if (!cand || !cand.fullName && !cand.full_name && !cand.name) return false;
    if (sourceDepartment(cand) !== dept) return false;
    if (sourceYear(cand) !== y) return false;
    return sourceSection(cand) === sec;
  });
}

/**
 * Auto-match master candidates for a single class within an election.
 * The constituency is found (already created elsewhere); if the class has no
 * constituency yet it is created first (creating its 2 CR seats).
 *
 * @param {string|number} electionId
 * @param {{department, year, section}} cls
 * @returns {Promise<{constituency, placed: Array, skipped: Array}>}
 */
/**
 * Master candidates are STATIC: they live once in Mongo `candidates` with
 * position_id null. Elections LINK to them (linked_positions); they are never
 * cloned. Returns the matching master rows, or [] when the store is empty.
 */
async function mongoMastersForClass({ department, year, section }) {
  try {
    const dbc = await getSharedDb();
    if (!dbc) return [];
    const col = dbc.collection('candidates');
    const docs = await col.find({ position_id: null, positionId: null }).toArray();
    const dept = normalizeDepartment(department);
    const y = normalizeYear(year) || '';
    const sec = normalizeSection(section);
    if (!dept || !y) return [];
    return docs.filter((d) => {
      if (!d || !(d.fullName || d.full_name || d.name)) return false;
      if (normalizeDepartment(d.department ?? d.Department ?? '') !== dept) return false;
      if ((normalizeYear(d.year ?? d.Year) || '') !== y) return false;
      return normalizeSection(d.section ?? d.Section ?? '') === sec;
    });
  } catch (err) {
    console.warn('[masterCandidateMatcher] mongoMastersForClass failed:', err.message);
    return [];
  }
}

function candidateIdOf(cand) {
  if (cand == null) return null;
  return String(cand._id || cand.id || cand.postgresId || '') || null;
}

function linkedIdsOf(cand) {
  if (cand == null) return [];
  return Array.from(new Set([
    String(cand.position_id ?? cand.positionId ?? ''),
    ...(Array.isArray(cand.linked_positions) ? cand.linked_positions.map(String) : []),
    ...(Array.isArray(cand.linkedPositions) ? cand.linkedPositions.map(String) : []),
  ])).filter(Boolean);
}

/**
 * Auto-match master candidates for a single class within an election.
 * The constituency is found (already created elsewhere); if the class has no
 * constituency yet it is created first (creating its 2 CR seats).
 *
 * @param {string|number} electionId
 * @param {{department, year, section}} cls
 * @returns {Promise<{constituency, placed: Array, skipped: Array}>}
 */
async function matchClassForElection(electionId, cls) {
  const placed = [];
  const skipped = [];

  const department = normalizeDepartment(cls.department);
  const year = normalizeYear(cls.year) || '';
  const section = normalizeSection(cls.section);
  if (!department || !year) {
    return { constituency: null, placed, skipped };
  }

  const expectedSection = SECTIONLESS.includes(department) ? '' : section;

  let constituency = await constituencyService.findMatching({
    electionId,
    department,
    year,
    section: expectedSection,
    activeOnly: false,
  });
  if (!constituency) {
    try {
      constituency = await constituencyService.create({ electionId, department, year, section: expectedSection });
    } catch (err) {
      console.warn('[masterCandidateMatcher] constituency create failed', { electionId, department, year, code: err.code || err.message });
      constituency = await constituencyService.findMatching({
        electionId,
        department,
        year,
        section: expectedSection,
        activeOnly: false,
      });
    }
  }
  if (!constituency || !constituency.id) {
    return { constituency: null, placed, skipped };
  }

  const positions = await positionService.findByConstituencyId(constituency.id).catch(() => []);

  // Source: Mongo masters first (static, editable), JSON file as fallback.
  let candidates = await mongoMastersForClass({ department, year, section: expectedSection });
  if (!candidates.length) {
    candidates = candidatesForClass(jsonStore.readJsonCandidates(), { department, year, section: expectedSection });
  }

  // Track per-seat occupancy as we place. Single-gender classes (e.g. girls
  // only, no boys) spread their candidates across BOTH seats so two girls /
  // two boys become the two CRs; mixed classes keep gender-matched piling.
  const spread = isSingleGenderClass(candidates);
  const seatCounts = {};
  const bump = (seatId) => { seatCounts[seatId] = (seatCounts[seatId] || 0) + 1; };

  for (const cand of candidates) {
    const name = String(cand.fullName || cand.full_name || cand.name || '').trim();
    if (!name) {
      skipped.push({ name, reason: 'invalid name' });
      continue;
    }
    const seat = pickCrSeat(positions, cand, { seatCounts, spread });
    if (!seat) {
      skipped.push({ name, position: cand.position || null, reason: 'no seat' });
      continue;
    }
    const seatId = String(seat.id);

    // Resolve the STATIC master: Mongo masters carry _id directly; JSON
    // candidates resolve via findCanonicalCandidate (which returns the raw
    // Mongo doc, so prefer _id over the undefined legacy `id` field).
    let canonical = null;
    let canonicalId = candidateIdOf(cand);
    if (!canonicalId) {
      canonical = await candidateService.findCanonicalCandidate({ name, department, year, section: expectedSection });
      canonicalId = candidateIdOf(canonical);
    }
    if (!canonicalId) {
      skipped.push({ name, position_id: seat.id, position_name: seat.name, reason: 'no master candidate' });
      continue;
    }

    const linked = Array.from(new Set([...linkedIdsOf(cand), ...linkedIdsOf(canonical)]));
    if (linked.includes(seatId)) {
      skipped.push({ name, position_id: seat.id, position_name: seat.name, reason: 'already on ballot' });
      continue;
    }
    if (positions.some(p => linked.includes(String(p.id)))) {
      skipped.push({ name, position_id: seat.id, position_name: seat.name, reason: 'already placed in election' });
      continue;
    }

    // LINK the master — never clone it.
    try {
      const linkedDoc = await candidateService.linkToPosition(canonicalId, seatId);
      if (!linkedDoc) throw new Error('link failed');
      bump(seat.id);
      placed.push({
        id: linkedDoc.id,
        name,
        position_id: seat.id,
        position_name: seat.name,
      });
    } catch (err) {
      skipped.push({ name, position_id: seat.id, position_name: seat.name, reason: err.message });
    }
  }

  return { constituency, placed, skipped };
}

/**
 * Auto-match master candidates for many classes at once (order preserved).
 */
async function matchClassesForElection(electionId, classes) {
  const results = [];
  for (const cls of classes) {
    results.push(await matchClassForElection(electionId, cls));
  }
  return results;
}

module.exports = {
  matchClassForElection,
  matchClassesForElection,
  candidatesForClass,
};