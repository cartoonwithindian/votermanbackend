/**
 * Vote Service
 * Critical business logic for vote recording
 * Enforces: ONE vote per student per position per election
 */

const db = require('../db');
const crypto = require('crypto');
const { incVotesCast } = require('../monitoring/metrics');

class VoteService {
  /**
   * Cast a vote with full validation
   * Returns { success, vote, error, status }
   *
   * Supports two ballot paths in a mixed election:
   *  - CLUB position  : club_id is required, constituency ignored
   *  - CR position    : constituency_id is required, club ignored
   * The authoritative discriminator is the position row itself
   * (position.club_id XOR position.constituency_id).
   */
  async castVote({ studentId, electionId, clubId, positionId, candidateId, constituencyId }) {
    // Step 1: Validate all IDs are integers
    const parsedStudentId = parseInt(studentId);
    const parsedElectionId = parseInt(electionId);
    const parsedClubId = clubId !== null && clubId !== undefined && clubId !== '' ? parseInt(clubId) : NaN;
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

    // Exactly one of club_id / constituency_id may be supplied.
    const hasClub = !isNaN(parsedClubId);
    const hasConstituency = !isNaN(parsedConstituencyId);
    if (hasClub && hasConstituency) {
      return {
        success: false,
        error: 'Cannot supply both club_id and constituency_id for one vote',
        code: 'INVALID_BALLOT_SCOPE',
        status: 400
      };
    }

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

    // Step 4: Resolve the position — it decides which ballot path is valid.
    const positionCheck = await db.query(
      'SELECT id, club_id, constituency_id FROM positions WHERE id = $1 AND is_active = true',
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
    const isConstituencyPosition = position.constituency_id !== null && position.constituency_id !== undefined;

    if (hasClub && isConstituencyPosition) {
      return {
        success: false,
        error: 'This position is a Class Representative seat; constituency_id is required',
        code: 'INVALID_BALLOT_SCOPE',
        status: 400
      };
    }
    if (hasConstituency && !isConstituencyPosition) {
      return {
        success: false,
        error: 'This position belongs to a club; club_id is required',
        code: 'INVALID_BALLOT_SCOPE',
        status: 400
      };
    }

    // Step 5: Check authorization
    let authRows = (
      await db.query(
        `SELECT id, club_id, is_authorized, expires_at
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
        `INSERT INTO voter_authorizations (student_id, election_id, club_id, is_authorized)
         SELECT $1, $2, NULL, TRUE
         WHERE NOT EXISTS (
           SELECT 1 FROM voter_authorizations
           WHERE student_id = $1 AND election_id = $2 AND club_id IS NULL
         )`,
        [parsedStudentId, parsedElectionId]
      );
      authRows = (
        await db.query(
          `SELECT id, club_id, is_authorized, expires_at
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

    // The voter must hold an election-wide authorization (club_id IS NULL) to
    // vote on CR positions; a club-scoped authorization never covers CR seats.
    const authorizations = authRows;
    let authorization;
    if (isConstituencyPosition) {
      authorization = authorizations.find(row => row.club_id === null) || null;
      if (!authorization) {
        return {
          success: false,
          error: 'Student is not authorized for Class Representative voting',
          code: 'NOT_AUTHORIZED_FOR_CONSTITUENCY',
          status: 403
        };
      }
    } else {
      // Club path: pick the first valid authorization, then enforce scope below.
      authorization = authorizations[0];
    }

    // Check authorization expiration
    if (authorization.expires_at && new Date(authorization.expires_at) < now) {
      return {
        success: false,
        error: 'Authorization has expired',
        code: 'AUTHORIZATION_EXPIRED',
        status: 403
      };
    }

    if (!isConstituencyPosition) {
      // Club-specific authorization: exact club only, or election-wide (NULL).
      const ok = authorization.club_id === null || authorization.club_id === position.club_id;
      if (!ok) {
        return {
          success: false,
          error: 'Student is not authorized for this club',
          code: 'NOT_AUTHORIZED_FOR_CLUB',
          status: 403
        };
      }
    }

    let voteClubId = null;
    let voteConstituencyId = null;

    if (isConstituencyPosition) {
      // ---- CR path ----
      if (!hasConstituency || parsedConstituencyId !== position.constituency_id) {
        return {
          success: false,
          error: 'Constituency does not belong to this position',
          code: 'CONSTITUENCY_NOT_FOUND',
          status: 404
        };
      }

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

      voteConstituencyId = parsedConstituencyId;
    } else {
      // ---- Club path ----
      if (!hasClub || parsedClubId !== position.club_id) {
        return {
          success: false,
          error: 'Club not found in this election',
          code: 'CLUB_NOT_FOUND',
          status: 404
        };
      }

      // Verify club belongs to election
      const clubCheck = await db.query(
        'SELECT id FROM clubs WHERE id = $1 AND election_id = $2 AND is_active = true',
        [parsedClubId, parsedElectionId]
      );

      if (clubCheck.rows.length === 0) {
        return {
          success: false,
          error: 'Club not found in this election',
          code: 'CLUB_NOT_FOUND',
          status: 404
        };
      }

      voteClubId = parsedClubId;
    }

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
        `INSERT INTO votes (student_id, election_id, club_id, constituency_id, position_id, candidate_id, voted_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id, student_id, election_id, club_id, constituency_id, position_id, candidate_id, voted_at`,
        [parsedStudentId, parsedElectionId, voteClubId, voteConstituencyId, parsedPositionId, parsedCandidateId]
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
   * Returns club rows AND constituency (CR) rows.
   */
  async getElectionResults(electionId) {
    const clubResults = await db.query(
      `SELECT
        v.candidate_id,
        c.name as candidate_name,
        c.position_id,
        p.name as position_name,
        p.club_id,
        cl.name as club_name,
        NULL::integer as constituency_id,
        NULL::text as constituency_name,
        COUNT(v.id) as vote_count
       FROM votes v
       JOIN candidates c ON v.candidate_id = c.id
       JOIN positions p ON v.position_id = p.id
       JOIN clubs cl ON p.club_id = cl.id
       WHERE v.election_id = $1
       GROUP BY v.candidate_id, c.name, v.position_id, p.name, p.club_id, cl.name
       ORDER BY cl.name, p.display_order, c.display_order, vote_count DESC`,
      [electionId]
    );

    const constituencyResults = await db.query(
      `SELECT
        v.candidate_id,
        c.name as candidate_name,
        c.position_id,
        p.name as position_name,
        NULL::integer as club_id,
        NULL::text as club_name,
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

    const results = clubResults.rows.concat(constituencyResults.rows);
    return results;
  }

  /**
   * Get vote counts grouped by position
   */
  async getPositionResults(electionId, positionId) {
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
   * Process a raw results rowset into groups (club OR constituency) with
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
        let rank = 1;
        let prevVotes = -1;
        for (const cand of pos.candidates) {
          if (cand.vote_count !== prevVotes) {
            cand.rank = rank;
          }

          if (rank === 1) {
            cand.status = 'winner';
          } else if (rank === 2 && cand.vote_count === maxVotes) {
            cand.status = 'winner';
          } else if (rank <= pos.max_selections) {
            cand.status = 'elected';
          } else {
            cand.status = 'not_elected';
          }

          prevVotes = cand.vote_count;
          rank++;
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
   * Returns results by club -> position -> candidates (and, in mixed
   * elections, by constituency -> position -> candidates).
   */
  async getElectionResultsFull(electionId) {
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

    // Get club-backed results
    const clubRows = await db.query(
      `SELECT
        cl.id as club_id,
        cl.name as club_name,
        p.id as position_id,
        p.name as position_name,
        COALESCE(p.max_selections, 1) as max_selections,
        c.id as candidate_id,
        c.name as candidate_name,
        COUNT(v.id) as vote_count
       FROM votes v
       JOIN candidates c ON v.candidate_id = c.id
       JOIN positions p ON v.position_id = p.id
       JOIN clubs cl ON p.club_id = cl.id
       WHERE v.election_id = $1
       GROUP BY cl.id, cl.name, p.id, p.name, COALESCE(p.max_selections, 1), p.display_order, c.id, c.name, c.display_order
       ORDER BY cl.name, p.display_order, c.display_order, vote_count DESC`,
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

    const clubGrouped = this._groupResults(clubRows.rows, 'club_id', 'club_name');
    const constituencyGrouped = this._groupResults(constituencyRows.rows, 'constituency_id', 'constituency_name');

    return {
      election_id: parseInt(electionId),
      election_name: election.rows[0].name,
      election_status: election.rows[0].status,
      eligible_students: eligibleCount,
      ballots_submitted: votedCount,
      participation_rate: Math.round(participationRate * 10) / 10,
      total_candidates: clubGrouped.totalCandidates + constituencyGrouped.totalCandidates,
      total_clubs: clubGrouped.groups.length,
      total_constituencies: constituencyGrouped.groups.length,
      results_published_at: election.rows[0].results_published_at,
      results_published: election.rows[0].results_published_at !== null,
      clubs: clubGrouped.groups,
      constituencies: constituencyGrouped.groups,
    };
  }

  /**
   * Check if a student has voted for specific positions in an election
   * Returns { votedPositions, canVote }
   * Does NOT reveal which candidate was voted for
   */
  async checkVotes(studentId, electionId, positionIdList = null) {
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
