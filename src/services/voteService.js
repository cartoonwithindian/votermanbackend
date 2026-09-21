/**
 * Vote Service
 * Critical business logic for vote recording
 * Enforces: ONE vote per student per position per election
 */

const db = require('../db');
const crypto = require('crypto');
const { incVotesCast } = require('../monitoring/metrics');
const { getMongoDbName } = require('../utils/mongoDbName');

const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

class VoteService {
  /**
   * Cast a vote with full validation
   * Returns { success, vote, error, status }
   *
   * Class Representative ballot path only: every position is backed by a
   * constituency, and the vote is scoped to that constituency (department,
   * year, section). The authoritative discriminator is the position row's
   * constituency_id.
   */
  async castVote({ studentId, electionId, constituencyId, positionId, candidateId }) {
    // Mongo-only (Atlas M10): Postgres not configured — avoid 500.
    // Student portal POST /votes should not throw; return 503 so UI shows
    // friendly unavailable message instead of 500.
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const dbName = getMongoDbName();
            const votesCol = client.db(dbName).collection('votes');
            // Ensure unique index on (studentId, electionId, positionId) to prevent duplicate votes
            await votesCol.createIndex(
              { studentId: 1, electionId: 1, positionId: 1 },
              { unique: true, background: true }
            ).catch(() => {});
            // Minimal validation: check duplicate vote in Mongo
            const existing = await votesCol.findOne({
              studentId: parseInt(studentId),
              electionId: parseInt(electionId),
              positionId: parseInt(positionId),
            });
            if (existing) {
              return { success: false, error: 'You have already voted for this position', code: 'ALREADY_VOTED', status: 409 };
            }
            // Insert dummy vote in Mongo to allow student flow without Postgres
            const now = new Date();
            const mockVote = {
              student_id: parseInt(studentId),
              studentId: parseInt(studentId),
              election_id: parseInt(electionId),
              electionId: parseInt(electionId),
              constituency_id: constituencyId ? parseInt(constituencyId) : null,
              constituencyId: constituencyId ? parseInt(constituencyId) : null,
              position_id: parseInt(positionId),
              positionId: parseInt(positionId),
              candidate_id: parseInt(candidateId),
              candidateId: parseInt(candidateId),
              voted_at: now,
              createdAt: now,
            };
            const res = await votesCol.insertOne(mockVote);
            const vote = {
              id: res.insertedId,
              student_id: mockVote.student_id,
              election_id: mockVote.election_id,
              constituency_id: mockVote.constituency_id,
              position_id: mockVote.position_id,
              candidate_id: mockVote.candidate_id,
              voted_at: now,
            };
            incVotesCast();
            const receipt = await this.generateReceipt(vote.id, vote.election_id, vote.student_id);
            return { success: true, vote, receipt, status: 201 };
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('voteService.castVote mongo fallback failed:', e.message);
      }
      // Fallback dummy error (not 500) — keeps student portal from crashing
      return {
        success: false,
        error: 'Voting temporarily unavailable (Mongo-only mode)',
        code: 'SERVICE_UNAVAILABLE',
        status: 503,
      };
    }
    // Step 1: Validate all IDs are integers
    const parsedStudentId = parseInt(studentId);
    const parsedElectionId = parseInt(electionId);
    const parsedConstituencyId = constituencyId !== null && constituencyId !== undefined && constituencyId !== '' ? parseInt(constituencyId) : NaN;
    const parsedPositionId = parseInt(positionId);
    const parsedCandidateId = parseInt(candidateId);

    if (isNaN(parsedStudentId) || isNaN(parsedElectionId) ||
        isNaN(parsedPositionId) || isNaN(parsedCandidateId)) {
      return {
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID',
        status: 400
      };
    }

    const hasConstituency = !isNaN(parsedConstituencyId);

    // Step 2: Check student exists and is active
    const studentCheck = await db.query(
      'SELECT id, is_active FROM students WHERE id = $1',
      [parsedStudentId]
    );

    if (studentCheck.rows.length === 0) {
      return {
        success: false,
        error: 'Student not found',
        code: 'STUDENT_NOT_FOUND',
        status: 404
      };
    }

    if (!studentCheck.rows[0].is_active) {
      return {
        success: false,
        error: 'Student is not active',
        code: 'STUDENT_INACTIVE',
        status: 403
      };
    }

    // Step 3: Check election exists and is OPEN
    const electionCheck = await db.query(
      `SELECT id, status, start_time, end_time, name
       FROM elections WHERE id = $1`,
      [parsedElectionId]
    );

    if (electionCheck.rows.length === 0) {
      return {
        success: false,
        error: 'Election not found',
        code: 'ELECTION_NOT_FOUND',
        status: 404
      };
    }

    const election = electionCheck.rows[0];

    // Check election status is OPEN
    if (election.status !== 'OPEN') {
      return {
        success: false,
        error: `Election is ${election.status}, not OPEN`,
        code: 'ELECTION_NOT_OPEN',
        status: 403
      };
    }

    // Check election timing
    const now = new Date();
    if (election.start_time && now < new Date(election.start_time)) {
      return {
        success: false,
        error: 'Election has not started yet',
        code: 'ELECTION_NOT_STARTED',
        status: 403
      };
    }

    if (election.end_time && now > new Date(election.end_time)) {
      return {
        success: false,
        error: 'Election has ended',
        code: 'ELECTION_ENDED',
        status: 403
      };
    }

    // Step 4: Resolve the position — it must be a constituency-backed seat
    const positionCheck = await db.query(
      'SELECT id, constituency_id FROM positions WHERE id = $1 AND is_active = true',
      [parsedPositionId]
    );

    if (positionCheck.rows.length === 0) {
      return {
        success: false,
        error: 'Position not found or inactive',
        code: 'POSITION_NOT_FOUND',
        status: 404
      };
    }

    const position = positionCheck.rows[0];

    if (!hasConstituency || parsedConstituencyId !== position.constituency_id) {
      return {
        success: false,
        error: 'Constituency does not belong to this position',
        code: 'CONSTITUENCY_NOT_FOUND',
        status: 404
      };
    }

    // Step 5: Check authorization
    let authRows = (
      await db.query(
        `SELECT id, is_authorized, expires_at
         FROM voter_authorizations
         WHERE student_id = $1 AND election_id = $2 AND is_authorized = true`,
        [parsedStudentId, parsedElectionId]
      )
    ).rows;

    if (authRows.length === 0) {
      // No explicit grant yet: students the admin marked voting-eligible
      // earn their election-wide grant automatically on first vote attempt
      // (this is what the admin's eligibility toggle controls). Anyone
      // else still gets NOT_AUTHORIZED.
      const elig = await db.query(
        'SELECT id FROM students WHERE id = $1 AND is_active = TRUE AND voting_eligible = TRUE',
        [parsedStudentId]
      );
      if (elig.rows.length === 0) {
        return {
          success: false,
          error: 'Student is not authorized for this election',
          code: 'NOT_AUTHORIZED',
          status: 403
        };
      }
      await db.query(
        `INSERT INTO voter_authorizations (student_id, election_id, is_authorized)
         SELECT $1, $2, TRUE
         WHERE NOT EXISTS (
           SELECT 1 FROM voter_authorizations
           WHERE student_id = $1 AND election_id = $2
         )`,
        [parsedStudentId, parsedElectionId]
      );
      authRows = (
        await db.query(
          `SELECT id, is_authorized, expires_at
           FROM voter_authorizations
           WHERE student_id = $1 AND election_id = $2 AND is_authorized = true`,
          [parsedStudentId, parsedElectionId]
        )
      ).rows;
      if (authRows.length === 0) {
        return {
          success: false,
          error: 'Student is not authorized for this election',
          code: 'NOT_AUTHORIZED',
          status: 403
        };
      }
    }

    const authorization = authRows[0];

    // Check authorization expiration
    if (authorization.expires_at && new Date(authorization.expires_at) < now) {
      return {
        success: false,
        error: 'Authorization has expired',
        code: 'AUTHORIZATION_EXPIRED',
        status: 403
      };
    }

    // ---- CR path ----
    // Step 6-CR: Verify constituency belongs to election and is active
    const constituencyCheck = await db.query(
      'SELECT id, election_id, department, year, section, is_active FROM constituencies WHERE id = $1',
      [parsedConstituencyId]
    );

    if (constituencyCheck.rows.length === 0 || constituencyCheck.rows[0].election_id !== parsedElectionId) {
      return {
        success: false,
        error: 'Constituency not found in this election',
        code: 'CONSTITUENCY_NOT_FOUND',
        status: 404
      };
    }

    const constituency = constituencyCheck.rows[0];
    if (!constituency.is_active) {
      return {
        success: false,
        error: 'Constituency is not active',
        code: 'CONSTITUENCY_INACTIVE',
        status: 403
      };
    }

    // Step 7-CR: Server-side eligibility — the voter must belong to the
    // same department, year and section as the constituency. Identity is
    // read from the students row (server state), never from the request.
    const voterIdentity = await db.query(
      'SELECT department, year_or_semester, section FROM students WHERE id = $1',
      [parsedStudentId]
    );

    const voter = voterIdentity.rows[0];
    const match = (a, b) => (a ?? '').toString().trim().toLowerCase() === (b ?? '').toString().trim().toLowerCase();

    if (!match(constituency.department, voter.department) ||
        !match(constituency.year, voter.year_or_semester) ||
        !match(constituency.section, voter.section)) {
      return {
        success: false,
        error: 'You can only vote for the Class Representative of your own department, year and section',
        code: 'CONSTITUENCY_MISMATCH',
        status: 403
      };
    }

    const voteConstituencyId = parsedConstituencyId;

    // Step 8: Verify candidate belongs to position and is active
    const candidateCheck = await db.query(
      'SELECT id FROM candidates WHERE id = $1 AND position_id = $2 AND is_active = true',
      [parsedCandidateId, parsedPositionId]
    );

    if (candidateCheck.rows.length === 0) {
      return {
        success: false,
        error: 'Candidate not found or inactive',
        code: 'CANDIDATE_NOT_FOUND',
        status: 404
      };
    }

    // Step 9: Check for duplicate vote
    const duplicateCheck = await db.query(
      `SELECT id FROM votes
       WHERE student_id = $1 AND election_id = $2 AND position_id = $3`,
      [parsedStudentId, parsedElectionId, parsedPositionId]
    );

    if (duplicateCheck.rows.length > 0) {
      return {
        success: false,
        error: 'You have already voted for this position',
        code: 'ALREADY_VOTED',
        status: 409
      };
    }

    // Step 10: Record the vote (database unique constraint is the final authority)
    let voteResult;
    try {
      voteResult = await db.query(
        `INSERT INTO votes (student_id, election_id, constituency_id, position_id, candidate_id, voted_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, student_id, election_id, constituency_id, position_id, candidate_id, voted_at`,
        [parsedStudentId, parsedElectionId, voteConstituencyId, parsedPositionId, parsedCandidateId]
      );
    } catch (err) {
      // Handle duplicate vote constraint violation (race condition protection)
      if (err.code === '23505') {
        return {
          success: false,
          error: 'You have already voted for this position',
          code: 'ALREADY_VOTED',
          status: 409
        };
      }
      throw err;
    }

    // Step 11: Generate vote receipt
    const vote = voteResult.rows[0];
    incVotesCast();
    const receipt = await this.generateReceipt(vote.id, vote.election_id, vote.student_id);

    return {
      success: true,
      vote: vote,
      receipt: receipt,
      status: 201
    };
  }

  /**
   * Generate a vote receipt
   */
  async generateReceipt(voteId, electionId, studentId) {
    const nullifier = crypto.randomBytes(32).toString('hex');
    const timestamp = new Date().toISOString();
    const hashInput = `${voteId}:${electionId}:${studentId}:${timestamp}:${nullifier}`;
    const receiptHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    if (isMongoOnly) {
      // Mongo-only: try to persist receipt in Mongo, otherwise return dummy without DB
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(getMongoDbName()).collection('vote_receipts');
            const doc = { vote_id: voteId, voteId, election_id: electionId, electionId, student_id: studentId, studentId, receipt_hash: receiptHash, receiptHash, nullifier, created_at: new Date(), createdAt: new Date() };
            const res = await col.insertOne(doc);
            return { receiptId: res.insertedId, receiptHash, nullifier, createdAt: doc.created_at };
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('voteService.generateReceipt mongo fallback failed:', e.message);
      }
      return { receiptId: null, receiptHash, nullifier, createdAt: timestamp };
    }

    try {
      const result = await db.query(
        `INSERT INTO vote_receipts (vote_id, election_id, student_id, receipt_hash, nullifier)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, receipt_hash, nullifier, created_at`,
        [voteId, electionId, studentId, receiptHash, nullifier]
      );

      return {
        receiptId: result.rows[0].id,
        receiptHash: result.rows[0].receipt_hash,
        nullifier: result.rows[0].nullifier,
        createdAt: result.rows[0].created_at,
      };
    } catch (err) {
      // If receipt table doesn't exist, return hash without storing
      if (err.code === '42P01') { // table does not exist
        return {
          receiptId: null,
          receiptHash: receiptHash,
          nullifier: nullifier,
          createdAt: timestamp,
        };
      }
      throw err;
    }
  }

  /**
   * Get vote counts for an election (for results - called by admin)
   * Returns constituency (CR) rows.
   */
  async getElectionResults(electionId) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(getMongoDbName()).collection('votes');
            const pipeline = [
              { $match: { $or: [{ election_id: parseInt(electionId) }, { electionId: parseInt(electionId) }] } },
              { $group: { _id: '$candidate_id', candidate_id: { $first: '$candidate_id' }, position_id: { $first: '$position_id' }, vote_count: { $sum: 1 } } },
            ];
            const docs = await col.aggregate(pipeline).toArray();
            // Return empty-shaped rows compatible with caller; detailed joins omitted in Mongo-only
            return docs.map(d => ({ candidate_id: d.candidate_id, candidate_name: `Candidate ${d.candidate_id}`, position_id: d.position_id, position_name: 'Position', constituency_id: null, constituency_name: null, vote_count: String(d.vote_count) }));
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('voteService.getElectionResults mongo fallback failed:', e.message);
      }
      return [];
    }
    const constituencyResults = await db.query(
      `SELECT
        v.candidate_id,
        c.name as candidate_name,
        c.position_id,
        p.name as position_name,
        p.constituency_id,
        ct.name as constituency_name,
        COUNT(v.id) as vote_count
       FROM votes v
       JOIN candidates c ON v.candidate_id = c.id
       JOIN positions p ON v.position_id = p.id
       JOIN constituencies ct ON p.constituency_id = ct.id
       WHERE v.election_id = $1
       GROUP BY v.candidate_id, c.name, v.position_id, p.name, p.constituency_id, ct.name
       ORDER BY ct.department, ct.year, ct.section, p.display_order, c.display_order, vote_count DESC`,
      [electionId]
    );

    return constituencyResults.rows;
  }

  /**
   * Get vote counts grouped by position
   */
  async getPositionResults(electionId, positionId) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(getMongoDbName()).collection('votes');
            const docs = await col.aggregate([
              { $match: { $or: [{ election_id: parseInt(electionId) }, { electionId: parseInt(electionId) }], $or: [{ position_id: parseInt(positionId) }, { positionId: parseInt(positionId) }] } },
              { $group: { _id: '$candidate_id', candidate_id: { $first: '$candidate_id' }, candidate_name: { $first: '$candidate_name' }, vote_count: { $sum: 1 } } },
            ]).toArray();
            return docs.map(d => ({ candidate_id: d.candidate_id, candidate_name: d.candidate_name || `Candidate ${d.candidate_id}`, vote_count: String(d.vote_count) }));
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('voteService.getPositionResults mongo fallback failed:', e.message);
      }
      return [];
    }
    const results = await db.query(
      `SELECT
        v.candidate_id,
        c.name as candidate_name,
        COUNT(v.id) as vote_count
       FROM votes v
       JOIN candidates c ON v.candidate_id = c.id
       WHERE v.election_id = $1 AND v.position_id = $2
       GROUP BY v.candidate_id, c.name
       ORDER BY vote_count DESC, c.display_order`,
      [electionId, positionId]
    );

    return results.rows;
  }

  /**
   * Process a raw results rowset into groups (constituencies) with
   * percentages, ties and winner/elected status. Assumes rows carry:
   *   <group>_id, <group>_name, position_id, position_name, max_selections,
   *   candidate_id, candidate_name, vote_count
   */
  _groupResults(rows, groupIdKey, groupNameKey) {
    const groups = {};
    let totalCandidates = 0;

    for (const row of rows) {
      const gid = row[groupIdKey];
      if (!groups[gid]) {
        groups[gid] = {
          [groupIdKey]: gid,
          [groupNameKey]: row[groupNameKey],
          positions: {},
        };
      }

      const group = groups[gid];
      if (!group.positions[row.position_id]) {
        group.positions[row.position_id] = {
          position_id: row.position_id,
          position_name: row.position_name,
          max_selections: row.max_selections || 1,
          candidates: [],
          total_votes: 0,
        };
      }

      group.positions[row.position_id].candidates.push({
        candidate_id: row.candidate_id,
        candidate_name: row.candidate_name,
        vote_count: parseInt(row.vote_count),
      });

      group.positions[row.position_id].total_votes += parseInt(row.vote_count);
      totalCandidates++;
    }

    // Calculate percentages and ranks per position within each group.
    for (const gid of Object.keys(groups)) {
      for (const posId of Object.keys(groups[gid].positions)) {
        const pos = groups[gid].positions[posId];
        const total = pos.total_votes;

        let maxVotes = 0;
        for (const cand of pos.candidates) {
          cand.percentage = total > 0 ? (cand.vote_count / total) * 100 : 0;
          if (cand.vote_count > maxVotes) {
            maxVotes = cand.vote_count;
          }
        }

        pos.candidates.sort((a, b) => b.vote_count - a.vote_count);
        // Competition ranking: each distinct vote total gets the next rank, so
        // tied candidates share a rank AND still receive one (no undefined).
        // Every candidate tied with the leader counts as a winner.
        let prevVotes = -1;
        let rank = 1;
        for (let i = 0; i < pos.candidates.length; i++) {
          const cand = pos.candidates[i];
          if (cand.vote_count !== prevVotes) {
            rank = i + 1;
            prevVotes = cand.vote_count;
          }
          cand.rank = rank;

          if (maxVotes > 0 && cand.vote_count === maxVotes) {
            cand.status = 'winner';
          } else if (rank <= pos.max_selections) {
            cand.status = 'elected';
          } else {
            cand.status = 'not_elected';
          }
        }

        groups[gid].positions = Object.values(groups[gid].positions);
      }
    }

    return {
      groups: Object.values(groups),
      totalCandidates,
    };
  }

  /**
   * Get comprehensive election results
   * Returns results by constituency -> position -> candidates.
   */
  async getElectionResultsFull(electionId) {
    if (isMongoOnly) {
      try {
        const electionService = require('./electionService');
        const election = await electionService.findById(electionId);
        if (!election) return null;
        // Mongo-only: return empty aggregated structure to avoid 500
        return {
          election_id: parseInt(electionId),
          election_name: election.name,
          election_status: election.status,
          eligible_students: 0,
          ballots_submitted: 0,
          participation_rate: 0,
          total_candidates: 0,
          total_constituencies: 0,
          results_published_at: election.results_published_at || null,
          results_published: !!election.results_published_at,
          constituencies: [],
        };
      } catch (e) {
        console.warn('voteService.getElectionResultsFull mongo fallback failed:', e.message);
        return {
          election_id: parseInt(electionId),
          election_name: 'Election',
          election_status: 'OPEN',
          eligible_students: 0,
          ballots_submitted: 0,
          participation_rate: 0,
          total_candidates: 0,
          total_constituencies: 0,
          results_published_at: null,
          results_published: false,
          constituencies: [],
        };
      }
    }
    // Get election info
    const election = await db.query(
      'SELECT * FROM elections WHERE id = $1',
      [electionId]
    );

    if (election.rows.length === 0) {
      return null;
    }

    // Get eligible voter count (authorized students)
    const eligible = await db.query(
      `SELECT COUNT(DISTINCT student_id) as count
       FROM voter_authorizations
       WHERE election_id = $1 AND is_authorized = true`,
      [electionId]
    );

    // Get total votes cast
    const totalVotes = await db.query(
      'SELECT COUNT(DISTINCT student_id) as count FROM votes WHERE election_id = $1',
      [electionId]
    );

    // Get constituency-backed results (CR positions)
    const constituencyRows = await db.query(
      `SELECT
        ct.id as constituency_id,
        ct.name as constituency_name,
        p.id as position_id,
        p.name as position_name,
        COALESCE(p.max_selections, 1) as max_selections,
        c.id as candidate_id,
        c.name as candidate_name,
        COUNT(v.id) as vote_count
       FROM votes v
       JOIN candidates c ON v.candidate_id = c.id
       JOIN positions p ON v.position_id = p.id
       JOIN constituencies ct ON p.constituency_id = ct.id
       WHERE v.election_id = $1
       GROUP BY ct.id, ct.name, p.id, p.name, COALESCE(p.max_selections, 1), p.display_order, c.id, c.name, c.display_order
       ORDER BY ct.department, ct.year, ct.section, p.display_order, c.display_order, vote_count DESC`,
      [electionId]
    );

    // Calculate totals
    const eligibleCount = parseInt(eligible.rows[0]?.count || 0);
    const votedCount = parseInt(totalVotes.rows[0]?.count || 0);
    const participationRate = eligibleCount > 0 ? (votedCount / eligibleCount) * 100 : 0;

    const constituencyGrouped = this._groupResults(constituencyRows.rows, 'constituency_id', 'constituency_name');

    return {
      election_id: parseInt(electionId),
      election_name: election.rows[0].name,
      election_status: election.rows[0].status,
      eligible_students: eligibleCount,
      ballots_submitted: votedCount,
      participation_rate: Math.round(participationRate * 10) / 10,
      total_candidates: constituencyGrouped.totalCandidates,
      total_constituencies: constituencyGrouped.groups.length,
      results_published_at: election.rows[0].results_published_at,
      results_published: election.rows[0].results_published_at !== null,
      constituencies: constituencyGrouped.groups,
    };
  }

  /**
   * Check if a student has voted for specific positions in an election
   * Returns { votedPositions, canVote }
   * Does NOT reveal which candidate was voted for
   */
  async checkVotes(studentId, electionId, positionIdList = null) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(getMongoDbName()).collection('votes');
            const filter = { $or: [{ student_id: parseInt(studentId), election_id: parseInt(electionId) }, { studentId: parseInt(studentId), electionId: parseInt(electionId) }] };
            if (positionIdList) {
              filter.$or = filter.$or.map(f => ({ ...f, position_id: { $in: positionIdList.map(Number) } }));
              // simplified: query by student+election then filter in JS
              const docs = await col.find({ studentId: parseInt(studentId), electionId: parseInt(electionId) }).toArray();
              const votedPositions = [...new Set(docs.map(d => d.positionId ?? d.position_id).filter(Boolean))].filter(id => !positionIdList || positionIdList.includes(id));
              const filtered = positionIdList ? votedPositions.filter(id => positionIdList.includes(id)) : votedPositions;
              return { votedPositions: filtered, canVote: positionIdList ? filtered.length < positionIdList.length : true };
            }
            const docs = await col.find({ $or: [{ student_id: parseInt(studentId), election_id: parseInt(electionId) }, { studentId: parseInt(studentId), electionId: parseInt(electionId) }] }).toArray();
            const votedPositions = [...new Set(docs.map(d => d.position_id ?? d.positionId).filter(Boolean))];
            return { votedPositions, canVote: positionIdList ? positionIdList.filter(id => !votedPositions.includes(id)).length > 0 : true };
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('voteService.checkVotes mongo fallback failed:', e.message);
      }
      // Fallback: no votes recorded (empty) so portal loads without 500
      return { votedPositions: [], canVote: true };
    }
    let query = `
      SELECT DISTINCT position_id
      FROM votes
      WHERE student_id = $1 AND election_id = $2
    `;
    const params = [studentId, electionId];

    if (positionIdList) {
      query += ` AND position_id = ANY($3)`;
      params.push(positionIdList);
    }

    const result = await db.query(query, params);
    const votedPositions = result.rows.map(row => row.position_id);

    return {
      votedPositions,
      canVote: positionIdList
        ? positionIdList.filter(id => !votedPositions.includes(id)).length > 0
        : true, // If no specific positions, return true (they can vote for new positions)
    };
  }
}

module.exports = new VoteService();
