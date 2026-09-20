/**
 * GET /api/v1/admin/live — real-time admin dashboard snapshot (no mocks)
 *
 * Combines the same statistics as /admin/stats with a live candidate
 * leaderboard so the admin dashboard can update counters, charts and
 * rankings without a page refresh. Mounted behind requireAdmin in app.js.
 */
const db = require('../db');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

async function getLive(req, res) {
  if (isMongoOnly) {
    // Atlas M10 — return empty live stats (no Postgres)
    return res.json({
      data: {
        stats: {
          students: { total: 0, active: 0, voting_eligible: 0 },
          elections: { total: 0, open: 0, published: 0 },
          candidates: { total: 0 },
          votes: { total: 0, unique_voters: 0 },
          accessRequests: { total: 0, pending: 0 },
          pendingCandidateApplications: 0,
        },
        leaderboard: [],
        generatedAt: new Date().toISOString(),
      },
    });
  }
  try {
    const [
      students,
      elections,
      candidates,
      votes,
      requests,
      pendingApps,
      leaderboard,
    ] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE is_active)::int AS active,
                       COUNT(*) FILTER (WHERE voting_eligible)::int AS voting_eligible
                  FROM students WHERE role = 'STUDENT'`),
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
                       COUNT(*) FILTER (WHERE results_published_at IS NOT NULL)::int AS published
                  FROM elections`),
      db.query(`SELECT COUNT(*)::int AS total FROM candidates WHERE is_active = TRUE`),
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(DISTINCT student_id)::int AS unique_voters
                  FROM votes`),
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
                  FROM student_access_requests`),
      db.query(`SELECT COUNT(*)::int AS total
                  FROM candidate_applications WHERE status = 'under_review'`),
      db.query(`SELECT
                   c.id AS candidate_id,
                   c.name AS candidate_name,
                   p.name AS position_name,
                   e.id AS election_id,
                   e.name AS election_name,
                   ct.name AS scope_name,
                   COUNT(v.id)::int AS votes
                 FROM candidates c
                 JOIN positions p ON p.id = c.position_id
                 JOIN constituencies ct ON ct.id = p.constituency_id
                 JOIN elections e ON e.id = ct.election_id
                 LEFT JOIN votes v ON v.candidate_id = c.id AND v.position_id = p.id
                 WHERE c.is_active = TRUE
                 GROUP BY c.id, c.name, p.name, e.id, e.name, ct.name
                 ORDER BY votes DESC, c.name ASC
                 LIMIT 10`),
    ]);

    return res.json({
      data: {
        stats: {
          students: students.rows[0],
          elections: elections.rows[0],
          candidates: candidates.rows[0],
          votes: votes.rows[0],
          accessRequests: requests.rows[0],
          pendingCandidateApplications: pendingApps.rows[0].total,
        },
        leaderboard: leaderboard.rows,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('admin live results failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load live results.' } });
  }
}

module.exports = { getLive };