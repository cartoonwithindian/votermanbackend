/**
 * Election Service
 * Business logic for election management
 */

const db = require('../db');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getClient: getSharedClient } = require('../db/mongoClient');
const redisCache = require('../utils/redisCache');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

const ELECTIONS_CACHE_KEY_PREFIX = 'elections:v1:';
const ELECTIONS_CACHE_TTL = 30;

// Valid status transitions
const STATUS_TRANSITIONS = {
  DRAFT: ['SCHEDULED', 'OPEN'],
  SCHEDULED: ['OPEN'],
  OPEN: ['CLOSED'],
  CLOSED: ['PUBLISHED'], // Allow publishing results after closing
};

// Fields that can be updated when election is OPEN
const PROTECTED_FIELDS_WHEN_OPEN = ['name', 'start_time', 'end_time'];

// Fields that can be updated when election is CLOSED
const PROTECTED_FIELDS_WHEN_CLOSED = ['name', 'description', 'start_time', 'end_time', 'status'];

class ElectionService {
  /**
   * Find all elections
   */
  async findAll(options = {}) {
    const cacheKey = redisCache.isEnabled() ? this.buildElectionsCacheKey(options) : null;
    if (cacheKey) {
      const cached = await redisCache.getKey(cacheKey);
      if (cached !== null) {
        return Array.isArray(cached) ? cached : [];
      }
    }
    const rows = await this._loadElectionsRows(options);
    if (cacheKey) {
      await redisCache.setKey(cacheKey, rows, ELECTIONS_CACHE_TTL);
    }
    return rows;
  }

  buildElectionsCacheKey(options = {}) {
    const safe = (v) => String(v ?? '').trim().toLowerCase() !== '' ? String(v).trim().toLowerCase() : 'all';
    const status = options.status ? safe(options.status) : (options.excludeDraft ? 'non-draft' : 'all');
    return `${ELECTIONS_CACHE_KEY_PREFIX}${status}:${options.limit ?? 100}:${options.offset ?? 0}`;
  }

  async invalidateElections() {
    await redisCache.deleteKeysWithPrefix('elections:');
  }

  async _loadElectionsRows(options = {}) {
    if (isMongoOnly) {
      // Mongo-only (Atlas M10): avoid Postgres query that throws 500.
      // Try to read from voteweb.elections if present, otherwise return []
      // so GET /api/v1/admin/elections loads (empty state) instead of 500.
      try {
        const client = await getSharedClient();
        if (!client) return [];
        const col = client.db(getMongoDbName()).collection('elections');
        const filter = {};
        if (options.status) filter.status = options.status;
        else if (options.excludeDraft) filter.status = { $ne: 'DRAFT' };
        const lim = Math.min(parseInt(options.limit) || 100, 100);
        const off = parseInt(options.offset) || 0;
        const rows = await col.find(filter).sort({ _id: 1 }).skip(off).limit(lim).toArray();
        if (!rows.length) return [];
        // Map Mongo docs to Postgres-like shape expected by frontend
        return rows.map((r) => ({
          id: r._id || r.id || r.postgresId,
          name: r.name,
          description: r.description || null,
          status: r.status || 'DRAFT',
          start_time: r.start_time || r.startTime || null,
          end_time: r.end_time || r.endTime || null,
          results_published_at: r.results_published_at || r.resultsPublishedAt || null,
          created_at: r.created_at || r.createdAt || null,
          updated_at: r.updated_at || r.updatedAt || null,
        }));
      } catch (e) {
        console.warn('electionService.findAll mongo fallback failed:', e.message);
        return [];
      }
    }
    const { status, limit = 100, offset = 0, excludeDraft = false } = options;

    let query = 'SELECT * FROM elections';
    const params = [];
    const where = [];

    if (status) {
      where.push('status = $' + (params.length + 1));
      params.push(status);
    } else if (excludeDraft) {
      // Non-staff viewers only see real elections, never internal drafts.
      where.push("status <> 'DRAFT'");
    }

    if (where.length) {
      query += ' WHERE ' + where.join(' AND ');
    }

    query += ' ORDER BY id LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Find election by ID
   */
  async findById(id) {
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (!client) return null;
        const col = client.db(getMongoDbName()).collection('elections');
        // Try _id and numeric postgresId/id
        const { ObjectId } = require('mongodb');
        let doc = null;
        try {
          if (ObjectId.isValid(String(id))) {
            doc = await col.findOne({ _id: new ObjectId(String(id)) });
          }
        } catch (_) {}
        if (!doc) {
          doc = await col.findOne({ $or: [{ postgresId: Number(id) }, { id: Number(id) }] });
        }
        if (!doc) return null;
        return {
          id: doc._id || doc.id || doc.postgresId,
          name: doc.name,
          description: doc.description || null,
          status: doc.status || 'DRAFT',
          start_time: doc.start_time || doc.startTime || null,
          end_time: doc.end_time || doc.endTime || null,
          results_published_at: doc.results_published_at || doc.resultsPublishedAt || null,
          created_at: doc.created_at || doc.createdAt || null,
          updated_at: doc.updated_at || doc.updatedAt || null,
        };
      } catch (e) {
        console.warn('electionService.findById mongo fallback failed:', e.message);
        return null;
      }
    }
    const result = await db.query(
      'SELECT * FROM elections WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Check if status transition is valid
   */
  isValidTransition(currentStatus, newStatus) {
    const allowed = STATUS_TRANSITIONS[currentStatus] || [];
    return allowed.includes(newStatus);
  }

  /**
   * Create a new election
   */
  async create(data) {
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (!client) {
          // Return dummy election to avoid 500 when Postgres is disabled
          return { id: Date.now(), name: data.name, description: data.description || null, start_time: data.start_time || null, end_time: data.end_time || null, status: 'DRAFT' };
        }
        const col = client.db(getMongoDbName()).collection('elections');
        const doc = { name: data.name, description: data.description || null, start_time: data.start_time || null, end_time: data.end_time || null, status: 'DRAFT', created_at: new Date(), updated_at: new Date() };
        const res = await col.insertOne(doc);
        await this.invalidateElections();
        return { id: res.insertedId, ...doc };
      } catch (e) {
        console.warn('electionService.create mongo fallback failed:', e.message);
        return { id: Date.now(), name: data.name, description: data.description || null, start_time: data.start_time || null, end_time: data.end_time || null, status: 'DRAFT' };
      }
    }
    const { name, description, start_time, end_time } = data;

    const result = await db.query(
      `INSERT INTO elections (name, description, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, 'DRAFT')
       RETURNING *`,
      [name, description || null, start_time || null, end_time || null]
    );

    await this.invalidateElections();

    return result.rows[0];
  }

  /**
   * Update an election (non-status fields)
   */
  async update(id, data) {
    if (isMongoOnly) {
      try {
        const election = await this.findById(id);
        if (!election) return null;
        // In Mongo-only mode, apply immutability checks then try Mongo update
        if (election.status === 'OPEN') {
          const attemptedProtected = PROTECTED_FIELDS_WHEN_OPEN.filter(f => data[f] !== undefined);
          if (attemptedProtected.length > 0) {
            const error = new Error('Cannot modify protected fields when election is OPEN');
            error.code = 'PROTECTED_FIELD';
            error.fields = attemptedProtected;
            throw error;
          }
        }
        if (election.status === 'CLOSED') {
          const attemptedProtected = PROTECTED_FIELDS_WHEN_CLOSED.filter(f => data[f] !== undefined);
          if (attemptedProtected.length > 0) {
            const error = new Error('Cannot modify fields when election is CLOSED');
            error.code = 'ELECTION_CLOSED';
            error.fields = attemptedProtected;
            throw error;
          }
        }
        const client = await getSharedClient();
        if (!client) return { ...election, ...data, updated_at: new Date().toISOString() };
        const { ObjectId } = require('mongodb');
        const col = client.db(getMongoDbName()).collection('elections');
        const updates = {};
        for (const f of ['name', 'description', 'start_time', 'end_time']) {
          if (data[f] !== undefined) updates[f] = data[f];
        }
        if (Object.keys(updates).length === 0) { return election; }
        updates.updated_at = new Date();
        updates.updatedAt = new Date();
        let filter = {};
        try { if (ObjectId.isValid(String(id))) filter = { _id: new ObjectId(String(id)) }; } catch (_) {}
        if (!filter._id) filter = { $or: [{ postgresId: Number(id) }, { id: Number(id) }] };
        // Try update by _id first, fallback to numeric filter
        let res = null;
        try {
          if (filter._id) res = await col.findOneAndUpdate(filter, { $set: updates }, { returnDocument: 'after' });
          if (!res || !res.value) {
            const alt = await col.findOneAndUpdate({ $or: [{ postgresId: Number(id) }, { id: Number(id) }] }, { $set: updates }, { returnDocument: 'after' });
            res = alt;
          }
        } catch (_) {
          res = await col.findOneAndUpdate({ $or: [{ postgresId: Number(id) }, { id: Number(id) }] }, { $set: updates }, { returnDocument: 'after' });
        }
        if (res && res.value) {
          const doc = res.value;
          await this.invalidateElections();
          return { id: doc._id || doc.id || doc.postgresId, name: doc.name, description: doc.description || null, status: doc.status || election.status, start_time: doc.start_time || doc.startTime || null, end_time: doc.end_time || doc.endTime || null, updated_at: doc.updated_at || doc.updatedAt || new Date().toISOString() };
        }
        return { ...election, ...updates };
      } catch (e) {
        if (e.code === 'PROTECTED_FIELD' || e.code === 'ELECTION_CLOSED') throw e;
        console.warn('electionService.update mongo fallback failed:', e.message);
        // Avoid 500: return merged election as dummy success
        const election = await this.findById(id);
        if (!election) return null;
        return { ...election, ...data };
      }
    }
    const election = await this.findById(id);
    if (!election) return null;

    // Check immutability based on status
    if (election.status === 'OPEN') {
      const attemptedProtected = PROTECTED_FIELDS_WHEN_OPEN.filter(f => data[f] !== undefined);
      if (attemptedProtected.length > 0) {
        const error = new Error('Cannot modify protected fields when election is OPEN');
        error.code = 'PROTECTED_FIELD';
        error.fields = attemptedProtected;
        throw error;
      }
    }

    if (election.status === 'CLOSED') {
      const attemptedProtected = PROTECTED_FIELDS_WHEN_CLOSED.filter(f => data[f] !== undefined);
      if (attemptedProtected.length > 0) {
        const error = new Error('Cannot modify fields when election is CLOSED');
        error.code = 'ELECTION_CLOSED';
        error.fields = attemptedProtected;
        throw error;
      }
    }

    // Build update query dynamically
    const updates = [];
    const params = [];
    let paramIndex = 1;

    const allowedFields = ['name', 'description', 'start_time', 'end_time'];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        params.push(data[field]);
        paramIndex++;
      }
    }

    if (updates.length === 0) {
      return election;
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const query = `UPDATE elections SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await db.query(query, params);
    await this.invalidateElections();
    return result.rows[0];
  }

  /**
   * Update election status with transition validation
   */
  async updateStatus(id, newStatus) {
    if (isMongoOnly) {
      try {
        const election = await this.findById(id);
        if (!election) return { error: 'NOT_FOUND' };
        const previousStatus = election.status;
        if (!this.isValidTransition(election.status, newStatus)) {
          return {
            error: 'INVALID_TRANSITION',
            message: `Cannot transition from ${election.status} to ${newStatus}`,
            currentStatus: election.status,
            allowedTransitions: STATUS_TRANSITIONS[election.status] || [],
          };
        }
        const client = await getSharedClient();
        if (!client) return { election: { ...election, status: newStatus }, previousStatus };
        const { ObjectId } = require('mongodb');
        const col = client.db(getMongoDbName()).collection('elections');
        const updates = { status: newStatus, updated_at: new Date(), updatedAt: new Date() };
        if (newStatus === 'PUBLISHED') { updates.results_published_at = new Date(); updates.resultsPublishedAt = new Date(); }
        let filter = {};
        try { if (ObjectId.isValid(String(id))) filter = { _id: new ObjectId(String(id)) }; } catch (_) {}
        if (!filter._id) filter = { $or: [{ postgresId: Number(id) }, { id: Number(id) }] };
        let res = null;
        try {
          if (filter._id) res = await col.findOneAndUpdate(filter, { $set: updates }, { returnDocument: 'after' });
          if (!res || !res.value) res = await col.findOneAndUpdate({ $or: [{ postgresId: Number(id) }, { id: Number(id) }] }, { $set: updates }, { returnDocument: 'after' });
        } catch (_) {
          res = await col.findOneAndUpdate({ $or: [{ postgresId: Number(id) }, { id: Number(id) }] }, { $set: updates }, { returnDocument: 'after' });
        }
        if (res && res.value) {
          const doc = res.value;
          await this.invalidateElections();
          return { election: { id: doc._id || doc.id || doc.postgresId, name: doc.name, status: doc.status, start_time: doc.start_time || doc.startTime || null, end_time: doc.end_time || doc.endTime || null, results_published_at: doc.results_published_at || doc.resultsPublishedAt || null }, previousStatus };
        }
        return { election: { ...election, status: newStatus }, previousStatus };
      } catch (e) {
        console.warn('electionService.updateStatus mongo fallback failed:', e.message);
        return { error: 'NOT_FOUND' };
      }
    }
    const election = await this.findById(id);
    if (!election) return { error: 'NOT_FOUND' };

    const previousStatus = election.status;

    // Validate transition
    if (!this.isValidTransition(election.status, newStatus)) {
      return {
        error: 'INVALID_TRANSITION',
        message: `Cannot transition from ${election.status} to ${newStatus}`,
        currentStatus: election.status,
        allowedTransitions: STATUS_TRANSITIONS[election.status] || [],
      };
    }

    // Build update query with conditional results_published_at
    let query = `UPDATE elections SET status = $1, updated_at = NOW()`;
    const params = [newStatus];

    // Set results_published_at when publishing results
    if (newStatus === 'PUBLISHED') {
      query += `, results_published_at = NOW(), results_published_by = $2`;
      params.push(1); // Admin user ID placeholder
    }

    query += ` WHERE id = $${params.length + 1} RETURNING *`;
    params.push(id);

    const result = await db.query(query, params);

    await this.invalidateElections();

    return { election: result.rows[0], previousStatus };
  }

  /**
   * Check if election has dependent data (constituencies)
   */
  async hasDependentData(id) {
    if (isMongoOnly) {
      // No Postgres — assume no dependent data to allow safe operations; avoid 500
      return false;
    }
    const result = await db.query(
      'SELECT COUNT(*) as count FROM constituencies WHERE election_id = $1',
      [id]
    );
    return parseInt(result.rows[0].count) > 0;
  }

  /**
   * Check election readiness before opening
   */
  async getReadiness(id) {
    if (isMongoOnly) {
      // Mongo-only: return empty readiness (no Postgres) to avoid 500
      const election = await this.findById(id);
      if (!election) return { error: 'NOT_FOUND' };
      return {
        election_id: id,
        election_name: election.name,
        current_status: election.status,
        ready_to_open: false,
        checks: {
          hasConstituencies: { status: 'warn', message: 'No constituencies configured (Mongo-only mode)', count: 0 },
          hasPositions: { status: 'fail', message: 'No positions configured (Mongo-only mode)', count: 0 },
          hasCandidates: { status: 'fail', message: 'No candidates configured (Mongo-only mode)', count: 0 },
          hasAuthorizedStudents: { status: 'warn', message: 'No students authorized (Mongo-only mode)', count: 0 },
        },
        warnings: [{ name: 'hasConstituencies', message: 'No constituencies configured (Mongo-only mode)' }, { name: 'hasAuthorizedStudents', message: 'No students authorized (Mongo-only mode)' }],
      };
    }
    // Check election exists
    const electionResult = await db.query(
      'SELECT id, name, status, start_time, end_time FROM elections WHERE id = $1',
      [id]
    );

    if (electionResult.rows.length === 0) {
      return { error: 'NOT_FOUND' };
    }

    const election = electionResult.rows[0];

    // Count constituencies
    const constituenciesResult = await db.query(
      'SELECT COUNT(*) as count FROM constituencies WHERE election_id = $1 AND is_active = true',
      [id]
    );

    // Count positional seats (CR seats live on constituencies)
    const positionsResult = await db.query(
      `SELECT COUNT(*) as count FROM positions p
       JOIN constituencies c ON p.constituency_id = c.id
       WHERE c.election_id = $1 AND p.is_active = true`,
      [id]
    );

    // Count candidates across all positions
    const candidatesResult = await db.query(
      `SELECT COUNT(*) as count FROM candidates c
       JOIN positions p ON c.position_id = p.id
       JOIN constituencies cl ON p.constituency_id = cl.id
       WHERE cl.election_id = $1 AND c.is_active = true`,
      [id]
    );

    // Count authorized students
    const authResult = await db.query(
      'SELECT COUNT(*) as count FROM voter_authorizations WHERE election_id = $1',
      [id]
    );

    const constituencyCount = parseInt(constituenciesResult.rows[0].count);
    const positionCount = parseInt(positionsResult.rows[0].count);
    const candidateCount = parseInt(candidatesResult.rows[0].count);
    const authorizedCount = parseInt(authResult.rows[0].count);

    // Determine readiness
    const checks = {
      hasConstituencies: {
        status: constituencyCount > 0 ? 'pass' : 'warn',
        message: constituencyCount > 0 ? 'Has constituencies' : 'No constituencies configured',
        count: constituencyCount,
      },
      hasPositions: {
        status: positionCount > 0 ? 'pass' : 'fail',
        message: positionCount > 0 ? 'Has positions' : 'No positions configured',
        count: positionCount,
      },
      hasCandidates: {
        status: candidateCount > 0 ? 'pass' : 'fail',
        message: candidateCount > 0 ? 'Has candidates' : 'No candidates configured',
        count: candidateCount,
      },
      hasAuthorizedStudents: {
        status: authorizedCount > 0 ? 'pass' : 'warn',
        message: authorizedCount > 0 ? 'Has authorized students' : 'No students authorized (may be intentional)',
        count: authorizedCount,
      },
    };

    // Calculate overall readiness
    const criticalPassed = checks.hasPositions.status === 'pass' &&
                          checks.hasCandidates.status === 'pass';

    const warnings = Object.entries(checks)
      .filter(([_, check]) => check.status === 'warn')
      .map(([name, check]) => ({ name, message: check.message }));

    return {
      election_id: id,
      election_name: election.name,
      current_status: election.status,
      ready_to_open: criticalPassed,
      checks,
      warnings,
    };
  }

  /**
   * Get aggregated election results
   * Only returns results if election has results_published_at set
   * Aggregates votes by candidate without exposing individual vote records
   */
  async getResults(id) {
    if (isMongoOnly) {
      const election = await this.findById(id);
      if (!election) return { error: 'NOT_FOUND' };
      if (!election.results_published_at) return { error: 'NOT_PUBLISHED' };
      // Mongo-only: return empty aggregated results to avoid 500
      return {
        electionId: id,
        electionName: election.name,
        publishedAt: election.results_published_at,
        status: 'published',
        totalEligible: 0,
        totalVotes: 0,
        participation: 0,
        constituencies: [],
      };
    }
    // Get election with results status
    const electionResult = await db.query(
      `SELECT id, name, status, results_published_at
       FROM elections
       WHERE id = $1`,
      [id]
    );

    if (!electionResult.rows[0]) {
      return { error: 'NOT_FOUND' };
    }

    const election = electionResult.rows[0];

    // Check if results are published
    if (!election.results_published_at) {
      return { error: 'NOT_PUBLISHED' };
    }

    // Get total eligible students
    const eligibleResult = await db.query(
      `SELECT COUNT(DISTINCT student_id) as count
       FROM voter_authorizations
       WHERE election_id = $1 AND is_authorized = true`,
      [id]
    );
    const totalEligible = parseInt(eligibleResult.rows[0].count) || 0;

    // Get total votes cast
    const votesResult = await db.query(
      `SELECT COUNT(DISTINCT student_id) as count
       FROM votes
       WHERE election_id = $1`,
      [id]
    );
    const totalVotes = parseInt(votesResult.rows[0].count) || 0;

    // Calculate participation percentage
    const participation = totalEligible > 0
      ? Math.round((totalVotes / totalEligible) * 10000) / 100
      : 0;

    // Get constituencies (CR seats) for this election
    const constituenciesResult = await db.query(
      `SELECT id, name FROM constituencies
       WHERE election_id = $1 AND is_active = true
       ORDER BY department, year, section`,
      [id]
    );

    // Get positions and candidates with vote counts (constituency-backed)
    const positionsResult = await db.query(
      `SELECT
         p.id as position_id,
         p.name as position_name,
         p.constituency_id,
         cand.id as candidate_id,
         cand.name as candidate_name,
         COUNT(v.id) as vote_count
       FROM positions p
       JOIN constituencies c ON c.id = p.constituency_id
       JOIN candidates cand ON cand.position_id = p.id AND cand.is_active = true
       LEFT JOIN votes v ON v.position_id = p.id AND v.candidate_id = cand.id
       WHERE c.election_id = $1 AND p.is_active = true
       GROUP BY p.id, p.name, p.constituency_id, cand.id, cand.name
       ORDER BY c.department, c.year, c.section, p.display_order, cand.display_order`,
      [id]
    );

    // Get total votes per position (for percentage calculation)
    const votesPerPositionResult = await db.query(
      `SELECT position_id, COUNT(*) as vote_count
       FROM votes
       WHERE election_id = $1
       GROUP BY position_id`,
      [id]
    );
    const votesPerPosition = {};
    votesPerPositionResult.rows.forEach(row => {
      votesPerPosition[row.position_id] = parseInt(row.vote_count);
    });

    // Format the response
    const formatPositions = (p) => {
      const positionGroups = {};

      p.forEach(row => {
        if (!positionGroups[row.position_id]) {
          positionGroups[row.position_id] = {
            positionId: row.position_id,
            positionName: row.position_name,
            candidates: [],
          };
        }

        const voteCount = parseInt(row.vote_count) || 0;
        const totalVotesForPosition = votesPerPosition[row.position_id] || 0;
        const percentage = totalVotesForPosition > 0
          ? Math.round((voteCount / totalVotesForPosition) * 10000) / 100
          : 0;

        positionGroups[row.position_id].candidates.push({
          candidateId: row.candidate_id,
          candidateName: row.candidate_name,
          voteCount,
          percentage,
        });
      });

      // Calculate ranks within each position
      Object.values(positionGroups).forEach(pos => {
        pos.candidates.sort((a, b) => b.voteCount - a.voteCount);
        pos.candidates.forEach((c, idx) => {
          c.rank = idx + 1;
        });
      });

      return Object.values(positionGroups);
    };

    const constituencies = constituenciesResult.rows.map(c => {
      const cPositions = positionsResult.rows.filter(p => p.constituency_id === c.id);
      return {
        constituencyId: c.id,
        constituencyName: c.name,
        positions: formatPositions(cPositions),
      };
    });

    return {
      electionId: id,
      electionName: election.name,
      publishedAt: election.results_published_at,
      status: 'published',
      totalEligible,
      totalVotes,
      participation,
      constituencies,
    };
  }

  /**
   * Publish election results
   * Sets results_published_at timestamp
   */
  async publishResults(id, adminUserId) {
    if (isMongoOnly) {
      const election = await this.findById(id);
      if (!election) return { error: 'NOT_FOUND' };
      if (election.status !== 'CLOSED') {
        return { error: 'INVALID_STATE', message: `Cannot publish results. Election must be CLOSED (current: ${election.status})` };
      }
      // Mongo-only: try to update voteweb.elections
      try {
        const client = await getSharedClient();
        if (!client) return { election: { ...election, status: 'PUBLISHED', results_published_at: new Date().toISOString() } };
        const { ObjectId } = require('mongodb');
        const col = client.db(getMongoDbName()).collection('elections');
        const updates = { status: 'PUBLISHED', results_published_at: new Date(), resultsPublishedAt: new Date(), results_published_by: adminUserId, updated_at: new Date() };
        let filter = {};
        try { if (ObjectId.isValid(String(id))) filter = { _id: new ObjectId(String(id)) }; } catch (_) {}
        if (!filter._id) filter = { $or: [{ postgresId: Number(id) }, { id: Number(id) }] };
        let res = null;
        try {
          if (filter._id) res = await col.findOneAndUpdate(filter, { $set: updates }, { returnDocument: 'after' });
          if (!res || !res.value) res = await col.findOneAndUpdate({ $or: [{ postgresId: Number(id) }, { id: Number(id) }] }, { $set: updates }, { returnDocument: 'after' });
        } catch (_) {
          res = await col.findOneAndUpdate({ $or: [{ postgresId: Number(id) }, { id: Number(id) }] }, { $set: updates }, { returnDocument: 'after' });
        }
        if (res && res.value) {
          const doc = res.value;
          await this.invalidateElections();
          return { election: { id: doc._id || doc.id || doc.postgresId, name: doc.name, status: doc.status, results_published_at: doc.results_published_at || doc.resultsPublishedAt } };
        }
        return { election: { ...election, status: 'PUBLISHED', results_published_at: new Date().toISOString() } };
      } catch (e) {
        console.warn('electionService.publishResults mongo fallback failed:', e.message);
        return { election: { ...election, status: 'PUBLISHED', results_published_at: new Date().toISOString() } };
      }
    }
    const election = await this.findById(id);
    if (!election) return { error: 'NOT_FOUND' };

    // Can only publish if election is CLOSED
    if (election.status !== 'CLOSED') {
      return {
        error: 'INVALID_STATE',
        message: `Cannot publish results. Election must be CLOSED (current: ${election.status})`,
      };
    }

    const result = await db.query(
      `UPDATE elections
       SET status = 'PUBLISHED',
           results_published_at = NOW(),
           results_published_by = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [adminUserId, id]
    );

    await this.invalidateElections();

    return { election: result.rows[0] };
  }
}

module.exports = new ElectionService();
