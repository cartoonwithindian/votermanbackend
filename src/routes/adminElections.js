/**
 * Admin Election Routes
 * Administrative operations for election management
 * All routes require admin authentication
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const electionController = require('../controllers/electionController');
const { requireAdmin } = require('../middleware/requireAdmin');
const { csrfProtection } = require('../middleware/csrfProtection');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getClient: getSharedClient } = require('../db/mongoClient');
const { ObjectId } = require('mongodb');
const { normalizeYear } = require('../utils/yearNormalizer');
const { normalizeDepartment, normalizeSection } = require('../utils/classList');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

function mongoElectionRefMatch(eid, oid) {
  const or = [{ election_id: eid }, { electionId: eid }, { election_id: Number(eid) }, { electionId: Number(eid) }];
  if (oid) or.push({ election_id: oid }, { electionId: oid });
  return { $or: or };
}

const PUPIL_PROJECTION = {
  name: 1, department: 1, year: 1, section: 1,
  rollNumber: 1, roll_number: 1, student_id: 1,
  externalId: 1, external_id: 1,
};

// GET /api/v1/admin/elections - List all elections (admin only)
router.get('/', requireAdmin, electionController.list.bind(electionController));

// POST /api/v1/admin/elections - Create election (admin only)
router.post('/', requireAdmin, csrfProtection, electionController.create.bind(electionController));

// PATCH /api/v1/admin/elections/:id - Update election (admin only)
router.patch('/:id', requireAdmin, csrfProtection, electionController.update.bind(electionController));

// PATCH /api/v1/admin/elections/:id/status - Update election status (admin only)
router.patch('/:id/status', requireAdmin, csrfProtection, electionController.updateStatus.bind(electionController));

// GET /api/v1/admin/elections/:id/readiness - Check election readiness (admin only)
router.get('/:id/readiness', requireAdmin, electionController.getReadiness.bind(electionController));

// POST /api/v1/admin/elections/:id/publish - Publish election results (admin only)
router.post('/:id/publish', requireAdmin, csrfProtection, electionController.publishResults.bind(electionController));

// GET /api/v1/admin/elections/:id/turnout - Per-class voter turnout (admin only)
// For each class (department / year / section): authorized students, how many
// voted, how many are still pending, and the list of pending (not-yet-voted)
// students so admins can chase an election's lagging classes.
router.get('/:id/turnout', requireAdmin, async (req, res) => {
  if (isMongoOnly) {
    try {
      const client = await getSharedClient();
      if (!client) {
        return res.json({ data: { election: { id: String(req.params.id), name: 'Election', status: 'DRAFT' }, totals: { total_authorized: 0, total_voted: 0, total_pending: 0, participation_pct: 0 }, classes: [] } });
      }
      const dbName = getMongoDbName();
      const rawId = String(req.params.id);
      const eid = ObjectId.isValid(rawId) ? rawId : String(rawId);
      const oid = ObjectId.isValid(eid) ? new ObjectId(eid) : null;

      const eCol = client.db(dbName).collection('elections');
      let doc = null;
      try { if (oid) doc = await eCol.findOne({ _id: oid }); } catch (_) {}
      if (!doc) doc = await eCol.findOne({ $or: [{ postgresId: Number(eid) }, { id: Number(eid) }, { postgresId: eid }, { id: eid }] });
      if (!doc) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Election not found.' } });
      }

      const refMatch = mongoElectionRefMatch(eid, oid);
      const ctCol = client.db(dbName).collection('constituencies');
      const cts = await ctCol.find({ ...refMatch, is_active: { $ne: false } }, { projection: { department: 1, year: 1, section: 1 } }).toArray();
      const classDefs = cts.map((c) => ({
        department: c.department || 'Unassigned',
        year: c.year || '-',
        section: c.section == null ? '' : String(c.section),
      }));
      const keyOf = (d, y, s) => [normalizeDepartment(d || ''), normalizeYear(y || '') || '-', normalizeSection(s == null ? '' : s)].join('|');

      const pupilsCol = client.db(dbName).collection('students');
      const flagEligible = await pupilsCol.find({
        $or: [{ isActive: true }, { is_active: true }],
        $or: [{ votingEligible: true }, { voting_eligible: true }],
      }, { projection: PUPIL_PROJECTION }).toArray();

      const authCol = client.db(dbName).collection('voter_authorizations');
      const auths = await authCol.find(
        { ...refMatch, $or: [{ is_authorized: { $ne: false } }, { isAuthorized: { $ne: false } }] },
        { projection: { student_id: 1, studentId: 1 } }
      ).toArray();
      const authIds = new Set(auths.flatMap((a) => [a.student_id, a.studentId]).filter((x) => x != null).map((x) => String(x)));
      const authNums = [...authIds].map(Number).filter((n) => !isNaN(n));
      const authPupils = authIds.size
        ? await pupilsCol.find({
            $or: [
              { _id: { $in: [...authIds, ...authNums] } },
              { postgresId: { $in: [...authIds, ...authNums] } },
              { student_id: { $in: [...authIds] } },
            ],
          }, { projection: PUPIL_PROJECTION }).toArray()
        : [];

      const eligibleById = new Map();
      for (const s of [...flagEligible, ...authPupils]) {
        const k = String(s._id);
        if (!eligibleById.has(k)) eligibleById.set(k, s);
      }

      const votesCol = client.db(dbName).collection('votes');
      const voterRows = await votesCol.aggregate([
        { $match: refMatch },
        { $group: { _id: '$student_id' } },
        { $project: { _id: 0, sid: '$_id' } },
      ]).toArray();
      const voterStrIds = voterRows.map((v) => String(v.sid)).filter(Boolean);
      const voterNums = voterStrIds.map(Number).filter((n) => !isNaN(n));
      const voterPupils = voterStrIds.length
        ? await pupilsCol.find({
            $or: [
              { _id: { $in: [...voterStrIds, ...voterNums] } },
              { postgresId: { $in: [...voterStrIds, ...voterNums] } },
              { id: { $in: [...voterStrIds, ...voterNums] } },
            ],
          }, { projection: PUPIL_PROJECTION }).toArray()
        : [];
      const votedSet = new Set(voterPupils.map((s) => String(s._id)));

      const classes = classDefs.map((cd) => {
        const k = keyOf(cd.department, cd.year, cd.section);
        const eligible = [...eligibleById.values()].filter((s) => keyOf(s.department, s.year, s.section) === k);
        const votedN = eligible.filter((s) => votedSet.has(String(s._id))).length;
        const total_authorized = eligible.length;
        return {
          department: cd.department,
          year: cd.year,
          section: cd.section,
          total_authorized,
          voted: votedN,
          pending: total_authorized - votedN,
          participation_pct: total_authorized > 0 ? Math.round((votedN / total_authorized) * 1000) / 10 : 0,
          pending_voters: eligible
            .filter((s) => !votedSet.has(String(s._id)))
            .map((s) => ({
              studentId: String(s._id),
              student_id: s.student_id || s.externalId || s.external_id || String(s._id),
              name: s.name,
              roll_number: s.rollNumber || s.roll_number || null,
            })),
        };
      });

      const totalAuthorized = classes.reduce((a, c) => a + c.total_authorized, 0);
      const totalVoted = classes.reduce((a, c) => a + c.voted, 0);
      return res.json({
        data: {
          election: { id: String(doc._id || doc.id || doc.postgresId), name: doc.name, status: doc.status || 'DRAFT' },
          totals: {
            total_authorized: totalAuthorized,
            total_voted: totalVoted,
            total_pending: totalAuthorized - totalVoted,
            participation_pct: totalAuthorized > 0 ? Math.round((totalVoted / totalAuthorized) * 1000) / 10 : 0,
          },
          classes,
        },
      });
    } catch (e) {
      console.warn('admin turnout mongo failed:', e.message);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load voter turnout.' } });
    }
  }
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid election id.' } });
    }

    const election = await db.query(
      'SELECT id, name, status FROM elections WHERE id = $1',
      [id]
    );
    if (election.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Election not found.' } });
    }

    const classes = await db.query(
      `SELECT
         COALESCE(NULLIF(s.department, ''), 'Unassigned') AS department,
         COALESCE(NULLIF(s.year_or_semester, ''), '-') AS year,
         COALESCE(NULLIF(s.section, ''), '-') AS section,
         COUNT(*)::int AS total_authorized,
         COUNT(*) FILTER (WHERE v.student_id IS NOT NULL)::int AS voted,
         COUNT(*) FILTER (WHERE v.student_id IS NULL)::int AS pending
       FROM voter_authorizations va
       JOIN students s ON s.id = va.student_id
       LEFT JOIN (SELECT DISTINCT student_id, election_id FROM votes) v
         ON v.student_id = s.id AND v.election_id = va.election_id
       WHERE va.election_id = $1 AND va.is_authorized = true AND s.is_active = true
       GROUP BY 1, 2, 3
       ORDER BY department, year, section`,
      [id]
    );

    const pendingVoters = await db.query(
      `SELECT
         s.id,
         s.student_id,
         s.name,
         s.roll_number,
         COALESCE(NULLIF(s.department, ''), 'Unassigned') AS department,
         COALESCE(NULLIF(s.year_or_semester, ''), '-') AS year,
         COALESCE(NULLIF(s.section, ''), '-') AS section
       FROM voter_authorizations va
       JOIN students s ON s.id = va.student_id
       LEFT JOIN (SELECT DISTINCT student_id, election_id FROM votes) v
         ON v.student_id = s.id AND v.election_id = va.election_id
       WHERE va.election_id = $1 AND va.is_authorized = true AND s.is_active = true
         AND v.student_id IS NULL
       ORDER BY department, year, section, s.name`,
      [id]
    );

    const totalAuthorized = classes.rows.reduce((sum, c) => sum + c.total_authorized, 0);
    const totalVoted = classes.rows.reduce((sum, c) => sum + c.voted, 0);

    const classesWithVoters = classes.rows.map((c) => ({
      ...c,
      participation_pct: c.total_authorized > 0 ? Math.round((c.voted / c.total_authorized) * 1000) / 10 : 0,
      pending_voters: pendingVoters.rows
        .filter((p) => p.department === c.department && p.year === c.year && p.section === c.section)
        .map(({ id: studentId, student_id, name, roll_number }) => ({ studentId, student_id, name, roll_number })),
    }));

    return res.json({
      data: {
        election: election.rows[0],
        totals: {
          total_authorized: totalAuthorized,
          total_voted: totalVoted,
          total_pending: totalAuthorized - totalVoted,
          participation_pct: totalAuthorized > 0 ? Math.round((totalVoted / totalAuthorized) * 1000) / 10 : 0,
        },
        classes: classesWithVoters,
      },
    });
  } catch (error) {
    console.error('admin election turnout failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load voter turnout.' } });
  }
});

module.exports = router;
