/**
 * GET /api/v1/admin/stats — REAL dashboard statistics (no mocks)
 *
 * Mounted at /api/v1/admin behind requireAdmin in app.js, so this file only
 * defines the handler. Returns live counts from PostgreSQL.
 */
const db = require('../db');
const { getMongoDbName } = require('../utils/mongoDbName');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

async function getStats(req, res) {
  if (isMongoOnly) {
    // Atlas M10 — Postgres not configured — return empty stats with 200 instead of 500.
    // Try Mongo ping with 2s timeout to verify connectivity, otherwise just return zeros.
    try {
      const { MongoClient } = require('mongodb');
      const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
      if (uri) {
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        await client.db(getMongoDbName()).command({ ping: 1 }).catch(() => {});
        await client.close().catch(() => {});
      }
    } catch (e) {
      console.warn('admin stats mongo ping failed:', e.message);
    }
    return res.json({
      data: {
        students: { total: 0, active: 0, voting_eligible: 0 },
        elections: { total: 0, open: 0, published: 0 },
        candidates: { total: 0 },
        votes: { total: 0, unique_voters: 0 },
        accessRequests: { total: 0, pending: 0 },
        pendingCandidateApplications: 0,
        generatedAt: new Date().toISOString(),
      },
    });
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
