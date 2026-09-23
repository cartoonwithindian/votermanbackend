/**
 * GET /api/v1/admin/stats — REAL dashboard statistics (no mocks)
 *
 * Mounted at /api/v1/admin behind requireAdmin in app.js, so this file only
 * defines the handler. Returns live counts from PostgreSQL.
 */
const db = require('../db');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getClient: getSharedClient } = require('../db/mongoClient');
const redisCache = require('../utils/redisCache');
const { memoryCacheGet, memoryCacheSet } = require('../utils/memoryCache');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

async function getStats(req, res) {
  if (isMongoOnly) {
    const mem = memoryCacheGet('admin:stats:mem:v1');
    if (mem !== undefined) return res.json(mem);
    const cacheKey = redisCache.isEnabled() ? 'admin:stats:v1' : null;
    if (cacheKey) {
      const cached = await redisCache.getKey(cacheKey);
      if (cached !== null) {
        memoryCacheSet('admin:stats:mem:v1', cached, 12000);
        return res.json(cached);
      }
    }
    // Atlas M10 — Postgres not configured — gather real counts from Mongo.
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
      const payload = {
        data: {
          students: { total: studentsTotal, active: studentsActive, voting_eligible: studentsActive },
          elections: { total: electionsTotal, open: electionsOpen, published: 0 },
          candidates: { total: candidatesTotal },
          votes: { total: votesTotal, unique_voters: 0 },
          accessRequests: { total: 0, pending: 0 },
          pendingCandidateApplications: pendingApps,
          generatedAt: new Date().toISOString(),
        },
      };
      if (cacheKey) {
        await redisCache.setKey(cacheKey, payload, 3);
      }
      memoryCacheSet('admin:stats:mem:v1', payload, 3000);
      return res.json(payload);
    } catch (e) {
      console.warn('admin stats mongo query failed:', e.message);
    }
    const payload = {
      data: {
        students: { total: 0, active: 0, voting_eligible: 0 },
        elections: { total: 0, open: 0, published: 0 },
        candidates: { total: 0 },
        votes: { total: 0, unique_voters: 0 },
        accessRequests: { total: 0, pending: 0 },
        pendingCandidateApplications: 0,
        generatedAt: new Date().toISOString(),
      },
    };
    if (cacheKey) {
      await redisCache.setKey(cacheKey, payload, 3);
    }
    memoryCacheSet('admin:stats:mem:v1', payload, 3000);
    return res.json(payload);
  }
  try {
    const [students, elections, candidates, votes, requests, pendingApps] = await Promise.all([
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
    ]);

    return res.json({
      data: {
        students: students.rows[0],
        elections: elections.rows[0],
        candidates: candidates.rows[0],
        votes: votes.rows[0],
        accessRequests: requests.rows[0],
        pendingCandidateApplications: pendingApps.rows[0].total,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('admin stats failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load statistics.' } });
  }
}

module.exports = { getStats };
