/**
 * Vote Service
 * Critical business logic for vote recording
 * Enforces: ONE vote per student per position per election
 */

const db = require('../db');
const crypto = require('crypto');
const { incVotesCast } = require('../monitoring/metrics');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getClient: getSharedClient } = require('../db/mongoClient');
const { normalizeYear } = require('../utils/yearNormalizer');

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
    // Mongo-only (Atlas M10): same full validation as Postgres — the election,
    // position, constituency, voter eligibility and candidate all MUST be
    // verified before a vote is recorded. No permissive fallback.
    if (isMongoOnly) {
      const client = await getSharedClient();
      if (!client) {
        return { success: false, error: 'Voting temporarily unavailable', code: 'SERVICE_UNAVAILABLE', status: 503 };
      }
      const validated = await this._validateMongoVote(client, { studentId, electionId, constituencyId, positionId, candidateId });
      if (!validated.ok) {
        return { success: false, error: validated.error, code: validated.code, status: validated.status };
      }
      const votesCol = await this._mongoVotesCollection(client);
      await votesCol.createIndex({ studentId: 1, electionId: 1, positionId: 1 }, { unique: true, background: true }).catch(() => {});
      const now = new Date();
      const doc = {
        student_id: String(studentId),
        studentId: String(studentId),
        election_id: String(electionId),
        electionId: String(electionId),
        constituency_id: constituencyId ? String(constituencyId) : null,
        constituencyId: constituencyId ? String(constituencyId) : null,
        position_id: String(positionId),
        positionId: String(positionId),
        candidate_id: String(candidateId),
        candidateId: String(candidateId),
        voted_at: now,
        createdAt: now,
      };
      let insertResult;
      try {
        insertResult = await votesCol.insertOne(doc);
      } catch (e) {
        if (e && e.code === 11000) {
          return { success: false, error: 'You have already voted for this position', code: 'ALREADY_VOTED', status: 409 };
        }
        throw e;
      }
      const vote = {
        id: insertResult.insertedId,
        student_id: doc.student_id,
        election_id: doc.election_id,
        constituency_id: doc.constituency_id,
        position_id: doc.position_id,
        candidate_id: doc.candidate_id,
        voted_at: now,
      };
      incVotesCast();
      const receipt = await this.generateReceipt(vote.id, vote.election_id, vote.student_id);
      return { success: true, vote, receipt, status: 201 };
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
    const matchYear = (a, b) => match(normalizeYear(a), normalizeYear(b));

    if (!match(constituency.department, voter.department) ||
        !matchYear(constituency.year, voter.year_or_semester) ||
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
   * Cast a ballot: multiple position/candidate selections for the SAME
   * election and constituency, submitted atomically.
   *
   * Postgres: full DB transaction (inserts + receipts rollback together).
   * Mongo: every selection is fully validated BEFORE any write; writes are
   * then inserted and, if the unique index rejects any (race/duplicate), the
   * votes written by this call are removed so no partial ballot survives.
   *
   * selections: [{ positionId, candidateId }]
   */
  async castBallot({ studentId, electionId, constituencyId, selections }) {
    if (!Array.isArray(selections) || selections.length === 0) {
      return { success: false, error: 'Ballot selections are required', code: 'INVALID_BALLOT', status: 422 };
    }
    if (selections.length > 50) {
      return { success: false, error: 'Too many ballot selections', code: 'INVALID_BALLOT', status: 422 };
    }
    for (const sel of selections) {
      if (!sel || !sel.positionId || !sel.candidateId) {
        return { success: false, error: 'Each selection requires positionId and candidateId', code: 'INVALID_BALLOT', status: 422 };
      }
    }
    const seen = new Set();
    for (const sel of selections) {
      const key = String(sel.positionId);
      if (seen.has(key)) {
        return { success: false, error: 'Duplicate position in ballot', code: 'INVALID_BALLOT', status: 422 };
      }
      seen.add(key);
    }

    if (isMongoOnly) {
      const client = await getSharedClient();
      if (!client) {
        return { success: false, error: 'Voting temporarily unavailable', code: 'SERVICE_UNAVAILABLE', status: 503 };
      }
      const votesCol = await this._mongoVotesCollection(client);
      await votesCol.createIndex(
        { studentId: 1, electionId: 1, positionId: 1 },
        { unique: true, background: true }
      ).catch(() => {});

      // Validate every selection first — nothing written until all pass.
      const validated = [];
      for (const sel of selections) {
        const check = await this._validateMongoVote(client, {
          studentId, electionId, constituencyId, positionId: sel.positionId, candidateId: sel.candidateId,
        });
        if (!check.ok) return check; // {success:false, code, status, error}
        validated.push(sel);
      }

      const now = new Date();
      const insertedIds = [];
      try {
        for (const sel of validated) {
          const doc = {
            student_id: String(studentId),
            studentId: String(studentId),
            election_id: String(electionId),
            electionId: String(electionId),
            constituency_id: constituencyId ? String(constituencyId) : null,
            constituencyId: constituencyId ? String(constituencyId) : null,
            position_id: String(sel.positionId),
            positionId: String(sel.positionId),
            candidate_id: String(sel.candidateId),
            candidateId: String(sel.candidateId),
            voted_at: now,
            createdAt: now,
          };
          const res = await votesCol.insertOne(doc);
          insertedIds.push(res.insertedId);
        }
      } catch (e) {
        // Atomic no-partial: remove the votes this call wrote before failing.
        if (insertedIds.length) {
          await votesCol.deleteMany({ _id: { $in: insertedIds } }).catch(() => {});
        }
        if (e && e.code === 11000) {
          return { success: false, error: 'You have already voted for this position', code: 'ALREADY_VOTED', status: 409 };
        }
        throw e;
      }

      const votes = [];
      for (const sel of validated) {
        votes.push({ position_id: String(sel.positionId), candidate_id: String(sel.candidateId), voted_at: now });
        incVotesCast();
      }
      const receipts = [];
      for (const id of insertedIds) {
        const receipt = await this.generateReceipt(id, String(electionId), String(studentId));
        receipts.push(receipt);
      }
      return { success: true, votes, receipts, status: 201 };
    }

    // ---- Postgres: real transaction ----
    const parsedStudentId = parseInt(studentId);
    const parsedElectionId = parseInt(electionId);
    const parsedConstituencyId = constituencyId !== null && constituencyId !== undefined && constituencyId !== '' ? parseInt(constituencyId) : NaN;
    if (isNaN(parsedStudentId) || isNaN(parsedElectionId)) {
      return { success: false, error: 'Invalid ID format', code: 'INVALID_ID', status: 400 };
    }
    const hasConstituency = !isNaN(parsedConstituencyId);
    if (!hasConstituency) {
      return { success: false, error: 'Constituency is required for Class Representative ballot', code: 'INVALID_ID', status: 400 };
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const votes = [];
      let voteIdSeq;
      for (const sel of selections) {
        const parsedPositionId = parseInt(sel.positionId);
        const parsedCandidateId = parseInt(sel.candidateId);
        if (isNaN(parsedPositionId) || isNaN(parsedCandidateId)) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Invalid ID format', code: 'INVALID_ID', status: 400 };
        }

        // Step 2: student role/active state (shared, but re-check per selection is cheap)
        const studentCheck = await client.query(
          'SELECT id, is_active, voting_eligible FROM students WHERE id = $1',
          [parsedStudentId]
        );
        if (studentCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Student not found', code: 'STUDENT_NOT_FOUND', status: 404 };
        }
        const studentRow = studentCheck.rows[0];
        if (!studentRow.is_active) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Student is not active', code: 'STUDENT_INACTIVE', status: 403 };
        }

        // Step 3: election is OPEN + within window
        const electionCheck = await client.query(
          'SELECT id, status, start_time, end_time FROM elections WHERE id = $1',
          [parsedElectionId]
        );
        if (electionCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Election not found', code: 'ELECTION_NOT_FOUND', status: 404 };
        }
        const election = electionCheck.rows[0];
        if (election.status !== 'OPEN') {
          await client.query('ROLLBACK');
          return { success: false, error: `Election is ${election.status}, not OPEN`, code: 'ELECTION_NOT_OPEN', status: 403 };
        }
        const now = new Date();
        if (election.start_time && now < new Date(election.start_time)) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Election has not started yet', code: 'ELECTION_NOT_STARTED', status: 403 };
        }
        if (election.end_time && now > new Date(election.end_time)) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Election has ended', code: 'ELECTION_ENDED', status: 403 };
        }

        // Step 4: position must be constituency-backed + active
        const positionCheck = await client.query(
          'SELECT id, constituency_id FROM positions WHERE id = $1 AND is_active = true',
          [parsedPositionId]
        );
        if (positionCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Position not found or inactive', code: 'POSITION_NOT_FOUND', status: 404 };
        }
        const position = positionCheck.rows[0];
        if (parsedConstituencyId !== position.constituency_id) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Constituency does not belong to this position', code: 'CONSTITUENCY_NOT_FOUND', status: 404 };
        }

        // Step 5: authorization (explicit grant OR admin-marked voting-eligible)
        const authRows = (await client.query(
          'SELECT id, is_authorized, expires_at FROM voter_authorizations WHERE student_id = $1 AND election_id = $2 AND is_authorized = true',
          [parsedStudentId, parsedElectionId]
        )).rows;
        if (authRows.length === 0) {
          const elig = await client.query(
            'SELECT id FROM students WHERE id = $1 AND is_active = TRUE AND voting_eligible = TRUE',
            [parsedStudentId]
          );
          if (elig.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: 'Student is not authorized for this election', code: 'NOT_AUTHORIZED', status: 403 };
          }
          await client.query(
            `INSERT INTO voter_authorizations (student_id, election_id, is_authorized)
             SELECT $1, $2, TRUE WHERE NOT EXISTS (
               SELECT 1 FROM voter_authorizations WHERE student_id = $1 AND election_id = $2
             )`,
            [parsedStudentId, parsedElectionId]
          );
        }

        // Step 6: constituency belongs to election + active + matches the voter class
        const constituencyCheck = await client.query(
          'SELECT id, election_id, department, year, section, is_active FROM constituencies WHERE id = $1',
          [parsedConstituencyId]
        );
        if (constituencyCheck.rows.length === 0 || constituencyCheck.rows[0].election_id !== parsedElectionId) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Constituency not found in this election', code: 'CONSTITUENCY_NOT_FOUND', status: 404 };
        }
        const constituency = constituencyCheck.rows[0];
        if (!constituency.is_active) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Constituency is not active', code: 'CONSTITUENCY_INACTIVE', status: 403 };
        }
        const voterIdentity = await client.query(
          'SELECT department, year_or_semester, section FROM students WHERE id = $1',
          [parsedStudentId]
        );
        const voter = voterIdentity.rows[0];
        const match = (a, b) => (a ?? '').toString().trim().toLowerCase() === (b ?? '').toString().trim().toLowerCase();
        const matchYear = (a, b) => match(normalizeYear(a), normalizeYear(b));
        if (!match(constituency.department, voter.department) ||
            !matchYear(constituency.year, voter.year_or_semester) ||
            !match(constituency.section, voter.section)) {
          await client.query('ROLLBACK');
          return { success: false, error: 'You can only vote for the Class Representative of your own department, year and section', code: 'CONSTITUENCY_MISMATCH', status: 403 };
        }

        // Step 7: candidate belongs to position + active
        const candidateCheck = await client.query(
          'SELECT id FROM candidates WHERE id = $1 AND position_id = $2 AND is_active = true',
          [parsedCandidateId, parsedPositionId]
        );
        if (candidateCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Candidate not found or inactive', code: 'CANDIDATE_NOT_FOUND', status: 404 };
        }

        // Step 8: duplicate
        const duplicateCheck = await client.query(
          'SELECT id FROM votes WHERE student_id = $1 AND election_id = $2 AND position_id = $3',
          [parsedStudentId, parsedElectionId, parsedPositionId]
        );
        if (duplicateCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return { success: false, error: 'You have already voted for this position', code: 'ALREADY_VOTED', status: 409 };
        }

        // Step 9: insert vote (unique constraint is the final authority)
        let voteResult;
        try {
          voteResult = await client.query(
            `INSERT INTO votes (student_id, election_id, constituency_id, position_id, candidate_id, voted_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING id, student_id, election_id, constituency_id, position_id, candidate_id, voted_at`,
            [parsedStudentId, parsedElectionId, parsedConstituencyId, parsedPositionId, parsedCandidateId]
          );
        } catch (err) {
          if (err.code === '23505') {
            await client.query('ROLLBACK');
            return { success: false, error: 'You have already voted for this position', code: 'ALREADY_VOTED', status: 409 };
          }
          throw err;
        }
        votes.push(voteResult.rows[0]);
        incVotesCast();
      }

      // Step 10: receipts inside the same transaction
      const receipts = [];
      for (const vote of votes) {
        const receipt = await this.generateReceipt(vote.id, vote.election_id, vote.student_id, (sql, params) => client.query(sql, params));
        receipts.push(receipt);
      }

      await client.query('COMMIT');
      return { success: true, votes, receipts, status: 201 };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Full Mongo validation for a single vote selection, mirroring the Postgres
   * path. Returns { ok:true } or { success:false, code, status, error }.
   */
  async _validateMongoVote(client, { studentId, electionId, constituencyId, positionId, candidateId }) {
    const dbName = getMongoDbName();

    // 1. Student exists, active AND voting-eligible (same gate as Postgres).
    const studentsCol = client.db(dbName).collection('students');
    const student = await this._mongoFindById(studentsCol, studentId);
    if (!student) {
      return { success: false, error: 'Student not found', code: 'STUDENT_NOT_FOUND', status: 404 };
    }
    if (student.isActive === false || student.is_active === false) {
      return { success: false, error: 'Student is not active', code: 'STUDENT_INACTIVE', status: 403 };
    }
    const isEligible = student.votingEligible === true || student.voting_eligible === true;

    // 2. Election exists and is OPEN with valid timing.
    const electionService = require('./electionService');
    const election = await electionService.findById(electionId);
    if (!election) {
      return { success: false, error: 'Election not found', code: 'ELECTION_NOT_FOUND', status: 404 };
    }
    if (election.status !== 'OPEN') {
      return { success: false, error: `Election is ${election.status}, not OPEN`, code: 'ELECTION_NOT_OPEN', status: 403 };
    }
    const now = new Date();
    if (election.start_time && now < new Date(election.start_time)) {
      return { success: false, error: 'Election has not started yet', code: 'ELECTION_NOT_STARTED', status: 403 };
    }
    if (election.end_time && now > new Date(election.end_time)) {
      return { success: false, error: 'Election has ended', code: 'ELECTION_ENDED', status: 403 };
    }

    // 3. Position exists, active, and is constituency-backed.
    const positionsCol = client.db(dbName).collection('positions');
    const position = await this._mongoFindById(positionsCol, positionId);
    if (!position) {
      return { success: false, error: 'Position not found or inactive', code: 'POSITION_NOT_FOUND', status: 404 };
    }
    if (position.is_active === false || position.isActive === false) {
      return { success: false, error: 'Position not found or inactive', code: 'POSITION_NOT_FOUND', status: 404 };
    }
    const positionConstituencyId = position.constituency_id ?? position.constituencyId;
    const posMatchesConstituency = this._mongoIdEquals(positionConstituencyId, constituencyId);
    if (!posMatchesConstituency) {
      return { success: false, error: 'Constituency does not belong to this position', code: 'CONSTITUENCY_NOT_FOUND', status: 404 };
    }

    // 4. Authorization: explicit grant OR voting-eligible student.
    let authorized = isEligible;
    if (!authorized) {
      const authCol = client.db(dbName).collection('voter_authorizations');
      const grant = await authCol.findOne({
        $or: [
          { studentId: String(studentId), electionId: String(electionId) },
          { student_id: String(studentId), election_id: String(electionId) },
        ],
      });
      if (grant && grant.isAuthorized !== false && grant.is_authorized !== false) {
        authorized = true;
      }
    }
    if (!authorized) {
      return { success: false, error: 'Student is not authorized for this election', code: 'NOT_AUTHORIZED', status: 403 };
    }

    // 5. Constituency belongs to election, active, and matches the voter's class.
    const constituenciesCol = client.db(dbName).collection('constituencies');
    const constituency = await this._mongoFindById(constituenciesCol, constituencyId);
    if (!constituency) {
      return { success: false, error: 'Constituency not found in this election', code: 'CONSTITUENCY_NOT_FOUND', status: 404 };
    }
    const constituencyElectionId = constituency.election_id ?? constituency.electionId;
    if (!this._mongoIdEquals(constituencyElectionId, electionId)) {
      return { success: false, error: 'Constituency not found in this election', code: 'CONSTITUENCY_NOT_FOUND', status: 404 };
    }
    if (constituency.is_active === false || constituency.isActive === false) {
      return { success: false, error: 'Constituency is not active', code: 'CONSTITUENCY_INACTIVE', status: 403 };
    }

    const match = (a, b) => (a ?? '').toString().trim().toLowerCase() === (b ?? '').toString().trim().toLowerCase();
    const matchYear = (a, b) => match(normalizeYear(a), normalizeYear(b));
    const voterDept = student.department ?? student.dept;
    const voterYear = student.year ?? student.year_or_semester ?? student.yearOrSemester;
    const voterSection = student.section ?? '';
    if (!match(constituency.department, voterDept) ||
        !matchYear(constituency.year, voterYear) ||
        !match(constituency.section, voterSection)) {
      return { success: false, error: 'You can only vote for the Class Representative of your own department, year and section', code: 'CONSTITUENCY_MISMATCH', status: 403 };
    }

    // 6. Candidate exists, active, and belongs to the position.
    const candidatesCol = client.db(dbName).collection('candidates');
    const candidate = await this._mongoFindById(candidatesCol, candidateId);
    if (!candidate) {
      return { success: false, error: 'Candidate not found or inactive', code: 'CANDIDATE_NOT_FOUND', status: 404 };
    }
    if (candidate.is_active === false || candidate.isActive === false) {
      return { success: false, error: 'Candidate not found or inactive', code: 'CANDIDATE_NOT_FOUND', status: 404 };
    }
    const candidatePositionId = candidate.position_id ?? candidate.positionId;
    if (!this._mongoIdEquals(candidatePositionId, positionId)) {
      return { success: false, error: 'Candidate not found or inactive', code: 'CANDIDATE_NOT_FOUND', status: 404 };
    }

    // 7. Duplicate vote check.
    const votesCol = await this._mongoVotesCollection(client);
    const existing = await votesCol.findOne({
      $or: [
        { studentId: String(studentId), electionId: String(electionId), positionId: String(positionId) },
        { student_id: String(studentId), election_id: String(electionId), position_id: String(positionId) },
      ],
    });
    if (existing) {
      return { success: false, error: 'You have already voted for this position', code: 'ALREADY_VOTED', status: 409 };
    }

    return { ok: true };
  }

  /** Look up a Mongo doc by flexible id (ObjectId, string, or postgresId). */
  async _mongoFindById(col, id) {
    const { ObjectId } = require('mongodb');
    let doc = null;
    try {
      if (ObjectId.isValid(String(id))) {
        doc = await col.findOne({ _id: new ObjectId(String(id)) });
      }
    } catch (_) {}
    if (!doc && id !== undefined && id !== null) {
      doc = await col.findOne({
        $or: [
          { _id: String(id) },
          { id: String(id) },
          { id: Number(id) },
          { postgresId: Number(id) },
          { postgresId: String(id) },
        ],
      });
    }
    return doc;
  }

  /** Compare two Mongo ids that may be ObjectId, string, or number. */
  _mongoIdEquals(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return this._normalizeId(a) === this._normalizeId(b);
  }

  /** Normalize an id (ObjectId/string/number) to a string for comparison. */
  _normalizeId(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' && v !== null && v.toHexString) return v.toHexString();
    return String(v);
  }

  async _mongoVotesCollection(client) {
    const clientNullable = client || (await getSharedClient());
    return clientNullable.db(getMongoDbName()).collection('votes');
  }

  /**
   * Generate a vote receipt
   */
  async generateReceipt(voteId, electionId, studentId, q = null) {
    const nullifier = crypto.randomBytes(32).toString('hex');
    const timestamp = new Date().toISOString();
    const hashInput = `${voteId}:${electionId}:${studentId}:${timestamp}:${nullifier}`;
    const receiptHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    if (isMongoOnly) {
      // Mongo-only: try to persist receipt in Mongo, otherwise return dummy without DB
      try {
        const client = await getSharedClient();
        if (client) {
          const col = client.db(getMongoDbName()).collection('vote_receipts');
          const doc = { vote_id: voteId, voteId, election_id: electionId, electionId, student_id: studentId, studentId, receipt_hash: receiptHash, receiptHash, nullifier, created_at: new Date(), createdAt: new Date() };
          const res = await col.insertOne(doc);
          return { receiptId: res.insertedId, receiptHash, nullifier, createdAt: doc.created_at };
        }
      } catch (e) {
        console.warn('voteService.generateReceipt mongo fallback failed:', e.message);
      }
      return { receiptId: null, receiptHash, nullifier, createdAt: timestamp };
    }

    const queryFn = q || ((sql, params) => db.query(sql, params));

    try {
      const result = await queryFn(
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
        const client = await getSharedClient();
        if (client) {
          const dbName = getMongoDbName();
          const col = client.db(dbName).collection('votes');
          const pipeline = [
            { $match: { $or: [{ election_id: String(electionId) }, { electionId: String(electionId) }, { election_id: parseInt(electionId) }, { electionId: parseInt(electionId) }] } },
            { $group: { _id: '$candidate_id', candidate_id: { $first: '$candidate_id' }, position_id: { $first: '$position_id' }, vote_count: { $sum: 1 } } },
          ];
          const docs = await col.aggregate(pipeline).toArray();
          const candidatesCol = client.db(dbName).collection('candidates');
          const positionsCol = client.db(dbName).collection('positions');
          const constituenciesCol = client.db(dbName).collection('constituencies');
          const [candidateDocs, positionDocs, constituencyDocs] = await Promise.all([
            candidatesCol.find({}).toArray(),
            positionsCol.find({}).toArray(),
            constituenciesCol.find({}).toArray(),
          ]);
          const candName = new Map(candidateDocs.map((d) => [this._normalizeId(d._id), { name: d.name, positionId: this._normalizeId(d.position_id ?? d.positionId) }]));
          const posName = new Map(positionDocs.map((d) => [this._normalizeId(d._id), { name: d.name, constituencyId: this._normalizeId(d.constituency_id ?? d.constituencyId) }]));
          const constName = new Map(constituencyDocs.map((d) => [this._normalizeId(d._id), d.name]));
          return docs.map(d => {
            const cand = candName.get(this._normalizeId(d.candidate_id)) || {};
            const posId = this._normalizeId(d.position_id) === '' ? cand.positionId : this._normalizeId(d.position_id);
            const pos = posName.get(posId) || {};
            const constituencyId = this._normalizeId(d.constituency_id);
            const resolvedConstituencyId = constituencyId || pos.constituencyId || null;
            return {
              candidate_id: d.candidate_id,
              candidate_name: cand.name || `Candidate ${d.candidate_id}`,
              position_id: d.position_id ?? cand.positionId,
              position_name: pos.name || 'Position',
              constituency_id: d.constituency_id || resolvedConstituencyId || null,
              constituency_name: (resolvedConstituencyId && constName.get(resolvedConstituencyId)) || null,
              vote_count: String(d.vote_count),
            };
          });
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
       JOIN positions p ON c.position_id = p.id
       JOIN constituencies ct ON p.constituency_id = ct.id
       WHERE v.election_id = $1
       GROUP BY v.candidate_id, c.name, c.position_id, p.name, p.constituency_id, ct.name, ct.department, ct.year, ct.section, p.display_order, c.display_order
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
        const client = await getSharedClient();
        if (client) {
          const col = client.db(getMongoDbName()).collection('votes');
          const docs = await col.aggregate([
            { $match: { $and: [
              { $or: [{ election_id: String(electionId) }, { electionId: String(electionId) }, { election_id: parseInt(electionId) }, { electionId: parseInt(electionId) }] },
              { $or: [{ position_id: String(positionId) }, { positionId: String(positionId) }, { position_id: parseInt(positionId) }, { positionId: parseInt(positionId) }] },
            ] } },
            { $group: { _id: '$candidate_id', candidate_id: { $first: '$candidate_id' }, vote_count: { $sum: 1 } } },
          ]).toArray();
          const candidatesCol = client.db(getMongoDbName()).collection('candidates');
          const candidateDocs = await candidatesCol.find({}).toArray();
          const nameById = new Map(candidateDocs.map((d) => [this._normalizeId(d._id), d.name]));
          return docs.map(d => ({ candidate_id: d.candidate_id, candidate_name: nameById.get(this._normalizeId(d.candidate_id)) || `Candidate ${d.candidate_id}`, vote_count: String(d.vote_count) }));
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
        const eidStr = String(electionId);
        const eidInt = parseInt(electionId);
        const client = await getSharedClient();
        const dbName = getMongoDbName();
        const votesCol = client.db(dbName).collection('votes');
        const match = { $or: [
          { election_id: eidStr }, { electionId: eidStr },
          { election_id: eidInt }, { electionId: eidInt },
        ] };
        const [constituencyRows, totalVotes] = await Promise.all([
          this.getElectionResults(electionId),
          votesCol.countDocuments(match),
        ]);
        const constituencyGrouped = this._groupResults(constituencyRows, 'constituency_id', 'constituency_name');
        const ballotsSubmitted = await votesCol.aggregate(
          [{ $match: match }, { $group: { _id: '$student_id', s: { $first: '$student_id' } } }, { $count: 'n' }]
        ).toArray();
        const votedCount = ballotsSubmitted[0]?.n ?? totalVotes;
        const eligCol = client.db(dbName).collection('voter_authorizations');
        const eligibleCount = await eligCol.countDocuments({
          $and: [
            { $or: [
              { electionId: eidStr }, { election_id: eidStr },
              { electionId: eidInt }, { election_id: eidInt },
            ] },
            { $or: [{ isAuthorized: true }, { is_authorized: true }] },
          ],
        });
        const participationRate = eligibleCount > 0 ? (votedCount / eligibleCount) * 100 : 0;
        return {
          election_id: eidInt && !isNaN(eidInt) && String(eidInt) === eidStr ? eidInt : eidStr,
          election_name: election.name,
          election_status: election.status,
          eligible_students: eligibleCount,
          ballots_submitted: votedCount,
          participation_rate: Math.round(participationRate * 10) / 10,
          total_candidates: constituencyGrouped.totalCandidates,
          total_constituencies: constituencyGrouped.groups.length,
          results_published_at: election.results_published_at || null,
          results_published: !!election.results_published_at,
          constituencies: constituencyGrouped.groups,
        };
      } catch (e) {
        console.warn('voteService.getElectionResultsFull mongo fallback failed:', e.message);
        return null;
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
        const client = await getSharedClient();
        if (client) {
          const col = client.db(getMongoDbName()).collection('votes');
          const studentStr = String(studentId);
          const electionStr = String(electionId);
          const baseFilter = { $or: [
            { student_id: studentStr, election_id: electionStr },
            { studentId: studentStr, electionId: electionStr },
            { student_id: parseInt(studentStr), election_id: parseInt(electionStr) },
            { studentId: parseInt(studentStr), electionId: parseInt(electionStr) },
          ] };
          const docs = await col.find(baseFilter).toArray();
          const votedPositions = [...new Set(docs.map(d => d.position_id ?? d.positionId).filter(Boolean).map(String))];
          return {
            votedPositions,
            canVote: positionIdList
              ? positionIdList.some(id => !votedPositions.includes(String(id)))
              : true,
          };
        }
      } catch (e) {
        console.warn('voteService.checkVotes mongo fallback failed:', e.message);
      }
      // Fallback: no votes recorded (empty) so portal loads without 500
      return { votedPositions: [], canVote: !positionIdList || positionIdList.length > 0 };
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
