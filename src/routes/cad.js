/**
 * CAD — Election Monitor routes (role: CAD or ADMIN)
 *
 * CAD is a READ-ONLY election-monitoring role (returning-officer style):
 *   - Live election overview with real turnout/statistics
 *   - Real election list and published status
 *   - Live results (per candidate, real vote counts)
 *   - Voter authorization status per election
 *
 * CAD can NOT: create/modify elections, manage students, approve access
 * requests, manage candidates, or access admin-only management APIs.
 *
 * All data is read live from PostgreSQL — no mocks anywhere.
 */
const express = require('express');
const router = express.Router();

const db = require('../db');
const { requireStaff } = require('../middleware/requireRole');

router.use(requireStaff);

// ---- GET /overview — real dashboard statistics ----
router.get('/overview', async (req, res) => {
  try {
    const [elections, students, votes, candidates, pendingRequests, liveElection] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
                       COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS closed
                  FROM elections`),
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE is_active)::int AS active,
                       COUNT(*) FILTER (WHERE voting_eligible)::int AS voting_eligible
                  FROM students WHERE role = 'STUDENT'`),
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(DISTINCT student_id)::int AS voters
                  FROM votes`),
      db.query(`SELECT COUNT(*)::int AS total FROM candidates WHERE is_active = TRUE`),
      db.query(`SELECT COUNT(*)::int AS total FROM student_access_requests WHERE status = 'pending'`),
      db.query(`SELECT id, name, status, start_time, end_time
                  FROM elections
                 WHERE status = 'OPEN'
                 ORDER BY start_time DESC NULLS LAST
                 LIMIT 1`),
    ]);

    const live = liveElection.rows[0] || null;
    let liveTurnout = null;
    if (live) {
      const [eligible, voted] = await Promise.all([
        db.query(`SELECT COUNT(DISTINCT student_id)::int AS n
                    FROM voter_authorizations WHERE election_id = $1 AND is_authorized = TRUE`, [live.id]),
        db.query(`SELECT COUNT(DISTINCT student_id)::int AS n
                    FROM votes WHERE election_id = $1`, [live.id]),
      ]);
      const e = eligible.rows[0].n;
      const v = voted.rows[0].n;
      liveTurnout = { eligibleVoters: e, studentsVoted: v, participationPct: e > 0 ? Math.round((v / e) * 1000) / 10 : 0 };
    }

    return res.json({
      data: {
        elections: elections.rows[0],
        students: students.rows[0],
        votes: votes.rows[0],
        candidates: candidates.rows[0],
        pendingAccessRequests: pendingRequests.rows[0].total,
        liveElection: live
          ? { id: live.id, name: live.name, status: live.status, startTime: live.start_time, endTime: live.end_time, turnout: liveTurnout }
          : null,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('cad overview failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load election overview.' } });
  }
});

// ---- GET /elections — real election list ----
router.get('/elections', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT e.id, e.name, e.status, e.start_time, e.end_time,
              (SELECT COUNT(*)::int FROM constituencies c WHERE c.election_id = e.id AND c.is_active) AS constituencies,
              (SELECT COUNT(*)::int FROM votes v WHERE v.election_id = e.id) AS votes_cast,
              (SELECT COUNT(DISTINCT student_id)::int FROM voter_authorizations va
                WHERE va.election_id = e.id AND va.is_authorized) AS eligible_voters
         FROM elections e
        ORDER BY e.created_at DESC`
    );
    return res.json({ data: { elections: rows.rows } });
  } catch (error) {
    console.error('cad elections failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load elections.' } });
  }
});

// ---- GET /elections/:id/results — real, live results ----
router.get('/elections/:id/results', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid election id.' } });
    }
    const voteService = require('../services/voteService');
    const full = await voteService.getElectionResultsFull(id);
    if (!full) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Election not found.' } });
    }
    return res.json({ data: full });
  } catch (error) {
    console.error('cad results failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load results.' } });
  }
});

// ---- GET /voters?electionId= — real voter authorization status ----
router.get('/voters', async (req, res) => {
  try {
    const electionId = parseInt(String(req.query.electionId || ''), 10);
    if (isNaN(electionId)) {
      return res.status(400).json({ error: { code: 'INVALID_ID', message: 'electionId query parameter is required.' } });
    }
    const rows = await db.query(
      `SELECT s.id, s.student_id, s.name, s.department, s.roll_number,
              va.is_authorized, va.expires_at,
              EXISTS (SELECT 1 FROM votes v WHERE v.student_id = s.id AND v.election_id = va.election_id) AS has_voted
         FROM voter_authorizations va
         JOIN students s ON s.id = va.student_id
        WHERE va.election_id = $1
        ORDER BY has_voted DESC, s.name
        LIMIT 500`,
      [electionId]
    );
    return res.json({ data: { voters: rows.rows } });
  } catch (error) {
    console.error('cad voters failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load voter status.' } });
  }
});

module.exports = router;
