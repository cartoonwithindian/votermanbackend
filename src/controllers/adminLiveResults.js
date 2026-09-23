/**
 * GET /api/v1/admin/live — real-time admin dashboard snapshot (no mocks)
 *
 * Combines the same statistics as /admin/stats with a live candidate
 * leaderboard so the admin dashboard can update counters, charts and
 * rankings without a page refresh. Mounted behind requireAdmin in app.js.
 */
const db = require('../db');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getClient: getSharedClient } = require('../db/mongoClient');
const redisCache = require('../utils/redisCache');
const { memoryCacheGet, memoryCacheSet } = require('../utils/memoryCache');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

async function getLive(req, res) {
  if (isMongoOnly) {
    const mem = memoryCacheGet('admin:live:mem:v1');
    if (mem !== undefined) return res.json(mem);
    const cacheKey = redisCache.isEnabled() ? 'admin:live:v1' : null;
    if (cacheKey) {
      const cached = await redisCache.getKey(cacheKey);
      if (cached !== null) {
        memoryCacheSet('admin:live:mem:v1', cached, 3000);
        return res.json(cached);
      }
    }
    try {
      const client = await getSharedClient();
      if (!client) throw new Error('MongoDB not configured');
      const dbMongo = client.db(getMongoDbName());
      const [studentsTotal, studentsActive, electionsTotal, electionsOpen, candidatesTotal, votesTotal, pendingApps] = await Promise.all([
        dbMongo.collection('students').countDocuments({ role: 'STUDENT' }),
        dbMongo.collection('students').countDocuments({ role: 'STUDENT', isActive: true }),
        dbMongo.collection('elections').countDocuments(),
        dbMongo.collection('elections').countDocuments({ status: 'OPEN' }),
        dbMongo.collection('candidates').countDocuments({ isActive: true }),
        dbMongo.collection('votes').countDocuments(),
        dbMongo.collection('candidate_applications').countDocuments({ status: 'under_review' }),
      ]);
      const [positions, constituencies, elections] = await Promise.all([
        dbMongo.collection('positions').find({}).toArray(),
        dbMongo.collection('constituencies').find({}).toArray(),
        dbMongo.collection('elections').find({}).toArray(),
      ]);
      const positionById = new Map();
      positions.forEach(p => {
        positionById.set(String(p._id), p);
        if (p.postgresId !== undefined && p.postgresId !== null) positionById.set(String(p.postgresId), p);
      });
      const constituencyById = new Map();
      constituencies.forEach(c => {
        constituencyById.set(String(c._id), c);
        if (c.postgresId !== undefined && c.postgresId !== null) constituencyById.set(String(c.postgresId), c);
      });
      const electionById = new Map();
      elections.forEach(e => {
        electionById.set(String(e._id), e);
        if (e.postgresId !== undefined && e.postgresId !== null) electionById.set(String(e.postgresId), e);
      });
      const voteCounts = new Map();
      const voteDocs = await dbMongo.collection('votes').find({}).project({ candidateId: 1, candidate_id: 1 }).toArray();
      voteDocs.forEach(v => {
        const cid = String(v.candidateId ?? v.candidate_id ?? '');
        if (cid) voteCounts.set(cid, (voteCounts.get(cid) || 0) + 1);
      });
      const activeCandidates = await dbMongo.collection('candidates').find({ isActive: true }).toArray();
      const leaderboard = activeCandidates
        .map(c => {
          const pos = positionById.get(String(c.position_id ?? c.positionId ?? ''));
          const ct = pos ? constituencyById.get(String(pos.constituency_id ?? pos.constituencyId ?? '')) : null;
          const e = ct ? electionById.get(String(ct.election_id ?? ct.electionId ?? '')) : null;
          return {
            candidate_id: String(c._id),
            candidate_name: c.name,
            position_name: pos ? pos.name : null,
            election_id: e ? String(e._id) : null,
            election_name: e ? e.name : null,
            scope_name: ct ? ct.name : null,
            votes: voteCounts.get(String(c._id)) || 0,
          };
        })
        .sort((a, b) => b.votes - a.votes || String(a.candidate_name).localeCompare(String(b.candidate_name)))
        .slice(0, 10);
      const payload = {
        data: {
          stats: {
            students: { total: studentsTotal, active: studentsActive, voting_eligible: studentsActive },
            elections: { total: electionsTotal, open: electionsOpen, published: 0 },
            candidates: { total: candidatesTotal },
            votes: { total: votesTotal, unique_voters: 0 },
            accessRequests: { total: 0, pending: 0 },
            pendingCandidateApplications: pendingApps,
          },
          leaderboard,
          generatedAt: new Date().toISOString(),
        },
      };
      if (cacheKey) {
        await redisCache.setKey(cacheKey, payload, 3);
      }
      memoryCacheSet('admin:live:mem:v1', payload, 3000);
      return res.json(payload);
    } catch (e) {
      console.error('admin live mongo failed:', e.message);
      // Fallback to empty if Atlas not reachable
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