/**
 * Vote Controller
 * HTTP handling for vote submission
 *
 * CRITICAL SECURITY BOUNDARY:
 * - Student identity comes exclusively from req.user (authenticated session)
 * - Request body/params student_id is IGNORED for authenticated users
 * - Prevents impersonation attacks (IDOR)
 */

const voteService = require('../services/voteService');
const db = require('../db');
const constituencyService = require('../services/constituencyService');
const { normalizeYear } = require('../utils/yearNormalizer');
const { getMongoDbName } = require('../utils/mongoDbName');
const { ObjectId } = require('mongodb');
const { getClient: getSharedClient } = require('../db/mongoClient');
const { resolveId } = require('../utils/idResolver');

const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

class VoteController {
  /**
   * POST /api/v1/elections/:electionId/votes
   * Submit a vote for a candidate
   *
   * Security: Student identity comes from req.user, never from request body
   */
  async submitVote(req, res, next) {
    try {
      const { electionId } = req.params;
      const { constituency_id, position_id, candidate_id, student_id: bodyStudentId } = req.body;

      // SECURITY: Get student identity from authenticated session ONLY
      // NEVER trust student_id from request body for production
      const authenticatedStudentId = req.user?.studentId;

      if (!authenticatedStudentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      // DEVELOPMENT BACKWARD COMPATIBILITY:
      // If body contains student_id AND matches authenticated user, allow it (for dev testing)
      // If body contains different student_id, reject it (security)
      if (bodyStudentId) {
        if (bodyStudentId !== authenticatedStudentId) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Cannot vote as another student.',
            code: 'IMPERSONATION_ATTEMPT',
          });
        }
        // bodyStudentId matches authenticated user - proceed
      }

      // Use authenticated identity
      const studentId = authenticatedStudentId;

      // Validation: required fields. constituency_id (CR seat) is required;
      // the vote service verifies the position is constituency-backed.
      if (!position_id || !candidate_id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'position_id and candidate_id are required.',
        });
      }

      if (!constituency_id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'constituency_id is required.',
        });
      }

      // Parse IDs (Mongo-only keeps hex string ids; Postgres parses ints)
      const constituencyId = isMongoOnly ? String(constituency_id || '').trim() : parseToInt(constituency_id);
      const positionId = isMongoOnly ? String(position_id || '').trim() : parseToInt(position_id);
      const candidateId = isMongoOnly ? String(candidate_id || '').trim() : parseToInt(candidate_id);
      const electionIdInt = isMongoOnly ? String(electionId || '').trim() : parseToInt(electionId);

      // Validate formats
      const invalidIds = isMongoOnly
        ? !constituencyId || !positionId || !candidateId || !electionIdInt
        : [positionId, candidateId, electionIdInt].some(isNaN);
      if (invalidIds) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid ID format.',
        });
      }

      // Call vote service with authenticated identity
      const result = await voteService.castVote({
        studentId,
        electionId: electionIdInt,
        constituencyId,
        positionId,
        candidateId,
      });

      if (!result.success) {
        return res.status(result.status).json({
          error: result.error,
          code: result.code,
        });
      }

      res.status(201).json({
        data: {
          success: true,
          message: 'Vote recorded successfully.',
          receipt: result.receipt,
        },
      });

    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/elections/:electionId/votes/ballot
   * Submit an atomic ballot of position/candidate selections for the SAME
   * election and constituency.
   *
   * Security: identity from session only; all selections validated against
   * the authenticated student's own class; commit is all-or-nothing.
   */
  async submitBallot(req, res, next) {
    try {
      const { electionId } = req.params;
      const { constituency_id, selections } = req.body;

      const authenticatedStudentId = req.user?.studentId;
      if (!authenticatedStudentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      const { student_id: bodyStudentId } = req.body || {};
      if (bodyStudentId && bodyStudentId !== authenticatedStudentId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot vote as another student.',
          code: 'IMPERSONATION_ATTEMPT',
        });
      }

      if (!constituency_id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'constituency_id is required.',
        });
      }

      const electionIdParsed = isMongoOnly ? String(electionId || '').trim() : parseToInt(electionId);
      const constituencyId = isMongoOnly ? String(constituency_id || '').trim() : parseToInt(constituency_id);
      if (isMongoOnly ? !electionIdParsed : isNaN(electionIdParsed)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid electionId format.',
        });
      }

      const result = await voteService.castBallot({
        studentId: authenticatedStudentId,
        electionId: electionIdParsed,
        constituencyId,
        selections,
      });

      if (!result.success) {
        return res.status(result.status).json({
          error: result.error,
          code: result.code,
        });
      }

      res.status(201).json({
        data: {
          success: true,
          message: 'Ballot recorded successfully.',
          count: result.votes.length,
          receipts: result.receipts,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/elections/:electionId/votes/check
   * Check if the authenticated student has voted in this election
   *
   * Security: Student identity from session only, not from query params
   */
  async checkVotes(req, res, next) {
    try {
      const { electionId } = req.params;
      const { position_ids } = req.query;

      // SECURITY: Get student identity from authenticated session ONLY
      const authenticatedStudentId = req.user?.studentId;

      if (!authenticatedStudentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      // SECURITY: Never accept student_id from query params (prevents IDOR)
      // If someone tries ?student_id=123, we ignore it and use authenticated identity
      const studentId = authenticatedStudentId;

      const electionIdInt = isMongoOnly ? String(electionId || '').trim() : parseToInt(electionId);
      if (isMongoOnly ? !electionIdInt : isNaN(electionIdInt)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid electionId format.',
        });
      }

      // Parse position_ids if provided (Mongo-only keeps hex string ids)
      let positionIdList = null;
      if (position_ids) {
        positionIdList = isMongoOnly
          ? position_ids.split(',').map(id => String(id).trim()).filter(Boolean)
          : position_ids.split(',').map(id => parseInt(id));
        if (isMongoOnly ? positionIdList.length === 0 : positionIdList.some(isNaN)) {
          return res.status(400).json({
            error: 'Bad Request',
            message: 'Invalid position_ids format',
          });
        }
      }

      const result = await voteService.checkVotes(studentId, electionIdInt, positionIdList);

      res.json({
        data: {
          voted_positions: result.votedPositions,
          can_vote: result.canVote,
        }
      });

    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/elections/:electionId/votes/my-constituency
   * Resolve the authenticated student's Class Representative constituency in
   * this election from their stored department/year/section.
   *
   * Security: identity comes from the session only; enrollments may be read
   * back from the students row (the same source used at vote time).
   */
  async getMyConstituency(req, res, next) {
    try {
      const { electionId } = req.params;

      // SECURITY: Get student identity from authenticated session ONLY
      const authenticatedStudentId = req.user?.studentId;

      if (!authenticatedStudentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      const electionIdInt = isMongoOnly ? String(electionId || '').trim() : parseToInt(electionId);

      if (isMongoOnly ? !electionIdInt : isNaN(electionIdInt)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid electionId format.',
        });
      }

      if (isMongoOnly) {
        // Mongo-only: try to resolve from session or Mongo students, then constituencyService (which is Mongo-aware)
        let row = null;
        try {
          // Prefer session-provided department/year/section if available
          if (req.user?.department && req.user?.year) {
            row = { department: req.user.department, year_or_semester: req.user.year, section: req.user.section || '' };
          } else {
            const client = await getSharedClient();
            if (client) {
              const col = client.db(getMongoDbName()).collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
              let doc = null;
              try { if (ObjectId.isValid(String(authenticatedStudentId))) doc = await col.findOne({ _id: new ObjectId(String(authenticatedStudentId)) }); } catch (_) {}
              if (!doc) doc = await col.findOne({ $or: [{ postgresId: parseInt(authenticatedStudentId) }, { id: String(authenticatedStudentId) }, { _id: String(authenticatedStudentId) }] });
              if (doc) row = { department: doc.department, year_or_semester: normalizeYear(doc.year || doc.year_or_semester || doc.yearOrSemester), section: doc.section || '' };
            }
          }
        } catch (e) {
          console.warn('voteController.my-constituency mongo fallback failed:', e.message);
        }
        if (!row || !row.department || !row.year_or_semester) {
          return res.json({ data: { constituency: null } });
        }
        const constituency = await constituencyService.findMatching({
          electionId: electionIdInt,
          department: row.department,
          year: normalizeYear(row.year_or_semester),
          section: row.section || '',
        });
        return res.json({ data: { constituency: constituency || null } });
      }

      const student = await db.query(
        'SELECT department, year_or_semester, section FROM students WHERE id = $1',
        [authenticatedStudentId]
      );

      if (student.rows.length === 0) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Student not found.',
          code: 'STUDENT_NOT_FOUND',
        });
      }

      const row = student.rows[0];
      // Section-less courses (MCA, MBA, BCom) store section as ""/NULL —
      // they still resolve their constituency by department + year.
      if (!row.department || !row.year_or_semester) {
        return res.json({ data: { constituency: null } });
      }

      const constituency = await constituencyService.findMatching({
        electionId: electionIdInt,
        department: row.department,
        year: normalizeYear(row.year_or_semester),
        section: row.section || '',
      });

      res.json({ data: { constituency } });
    } catch (err) {
      next(err);
    }
  }

  async getMyClassCandidates(req, res, next) {
    try {
      const authenticatedStudentId = req.user?.studentId;
      if (!authenticatedStudentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }
      const empty = { election: null, constituency: null, seats: [] };
      let department = req.user?.department || null;
      let year = req.user?.year || null;
      let section = req.user?.section || '';
      if ((!department || !year) && isMongoOnly) {
        try {
          const client = await getSharedClient();
          if (client) {
            const col = client.db(getMongoDbName()).collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
            let doc = null;
            try { if (ObjectId.isValid(String(authenticatedStudentId))) doc = await col.findOne({ _id: new ObjectId(String(authenticatedStudentId)) }); } catch (_) {}
            if (!doc) doc = await col.findOne({ $or: [{ postgresId: parseInt(authenticatedStudentId) }, { id: String(authenticatedStudentId) }, { _id: String(authenticatedStudentId) }] });
            if (doc) {
              department = department || doc.department || null;
              year = year || doc.year || doc.year_or_semester || doc.yearOrSemester || null;
              section = req.user?.section || doc.section || '';
            }
          }
        } catch (_) {}
      }
      if (!department || !year) return res.json({ data: empty });
      const normYear = normalizeYear(year);
      const electionService = require('../services/electionService');
      const positionService = require('../services/positionService');
      const candidateService = require('../services/candidateService');
      let elections = [];
      try { elections = await electionService.findAll({ limit: 100, offset: 0 }); } catch (_) { elections = []; }
      if (!Array.isArray(elections)) elections = [];
      const matches = [];
      for (const e of elections) {
        const eid = e.id ?? e._id ?? e.postgresId;
        if (eid === undefined || eid === null) continue;
        let ct = null;
        try {
          ct = await constituencyService.findMatching({ electionId: String(eid), department, year: normYear, section: section || '' });
        } catch (_) { ct = null; }
        if (ct) matches.push({ election: e, constituency: ct });
      }
      if (!matches.length) return res.json({ data: empty });
      const rank = { OPEN: 0, SCHEDULED: 1, DRAFT: 2, CLOSED: 3, PUBLISHED: 4 };
      matches.sort((a, b) => ((rank[a.election.status] ?? 9) - (rank[b.election.status] ?? 9)));
      const best = matches[0];
      let positions = [];
      try { positions = await positionService.findByConstituencyId(best.constituency.id, { activeOnly: false }); } catch (_) { positions = []; }
      positions = (Array.isArray(positions) ? positions : []).filter((p) => (p.is_active ?? p.isActive ?? true) !== false);
      const seats = [];
      for (const p of positions) {
        const pid = p.id ?? (p._id ? String(p._id) : null);
        if (!pid) continue;
        let cands = [];
        try { cands = await candidateService.findByPositionId(pid, { activeOnly: false, limit: 100 }); } catch (_) { cands = []; }
        cands = (Array.isArray(cands) ? cands : []).filter((c) => (c.is_active ?? c.isActive ?? true) !== false);
        seats.push({
          position: { id: String(pid), name: p.name },
          candidates: cands.map((c) => ({ id: String(c.id ?? c._id), name: c.name, gender: c.gender ?? null, photo: c.image_url ?? c.imageUrl ?? null })),
        });
      }
      const be = best.election;
      return res.json({ data: {
        election: { id: String(be.id ?? be._id ?? be.postgresId), name: be.name, status: be.status },
        constituency: { id: String(best.constituency.id), name: best.constituency.name, department: best.constituency.department, year: best.constituency.year, section: best.constituency.section, voting_open: best.constituency.voting_open },
        seats,
      } });
    } catch (err) {
      return res.json({ data: { election: null, constituency: null, seats: [] } });
    }
  }

  /**
   * GET /api/v1/elections/:electionId/votes/receipt
   * Get the authenticated student's receipt for an election (no voteId needed)
   *
   * Security: Only allow access to own receipts
   */
  async getMyElectionReceipt(req, res, next) {
    try {
      const { electionId } = req.params;

      // SECURITY: Get student identity from authenticated session ONLY
      const authenticatedStudentId = req.user?.studentId;

      if (!authenticatedStudentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      const electionIdInt = isMongoOnly ? String(electionId || '').trim() : parseToInt(electionId);

      if (isMongoOnly ? !electionIdInt : isNaN(electionIdInt)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid ID format.',
        });
      }

      if (isMongoOnly) {
        // Mongo-only: try Mongo vote_receipts collection, else 404 (not 500)
        try {
          const client = await getSharedClient();
          if (client) {
            const col = client.db(getMongoDbName()).collection('vote_receipts');
            const doc = await col.findOne({ $or: [{ student_id: String(authenticatedStudentId), election_id: String(electionIdInt) }, { studentId: String(authenticatedStudentId), electionId: String(electionIdInt) }, { student_id: parseInt(authenticatedStudentId), election_id: parseInt(electionIdInt) }, { studentId: parseInt(authenticatedStudentId), electionId: parseInt(electionIdInt) }] }, { sort: { created_at: -1, createdAt: -1 } });
            if (doc) {
              return res.json({ data: { receipt: { receiptId: doc._id ? String(doc._id) : doc.id, receiptHash: doc.receipt_hash ?? doc.receiptHash, nullifier: doc.nullifier, createdAt: doc.created_at ?? doc.createdAt } } });
            }
          }
        } catch (e) {
          console.warn('voteController.getMyElectionReceipt mongo fallback failed:', e.message);
        }
        return res.status(404).json({ error: 'Not Found', message: 'No receipt found for this election.', code: 'RECEIPT_NOT_FOUND' });
      }
      // SECURITY: Ownership enforced in query - only returns rows owned by this student
      const receiptResult = await db.query(
        `SELECT id, receipt_hash, nullifier, created_at
         FROM vote_receipts
         WHERE student_id = $1 AND election_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [authenticatedStudentId, electionIdInt]
      );

      if (receiptResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'No receipt found for this election.',
          code: 'RECEIPT_NOT_FOUND',
        });
      }

      res.json({
        data: {
          receipt: {
            receiptId: receiptResult.rows[0].id,
            receiptHash: receiptResult.rows[0].receipt_hash,
            nullifier: receiptResult.rows[0].nullifier,
            createdAt: receiptResult.rows[0].created_at,
          },
        },
      });

    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/elections/:electionId/votes/receipt/:voteId
   * Get vote receipt for the authenticated student
   *
   * Security: Only allow access to own receipts
   */
  async getReceipt(req, res, next) {
    try {
      const { electionId, voteId } = req.params;

      // SECURITY: Get student identity from authenticated session ONLY
      const authenticatedStudentId = req.user?.studentId;

      if (!authenticatedStudentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      const electionIdInt = isMongoOnly ? String(electionId || '').trim() : parseToInt(electionId);
      const voteIdInt = isMongoOnly ? String(voteId || '').trim() : parseToInt(voteId);

      if (isMongoOnly ? (!electionIdInt || !voteIdInt) : (isNaN(electionIdInt) || isNaN(voteIdInt))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid ID format.',
        });
      }

      if (isMongoOnly) {
        // Mongo-only: try Mongo votes + receipts collections, avoid Postgres 500
        try {
          const client = await getSharedClient();
          if (client) {
            const votesCol = client.db(getMongoDbName()).collection('votes');
            let vote = null;
            try { if (ObjectId.isValid(String(voteIdInt))) vote = await votesCol.findOne({ _id: new ObjectId(String(voteIdInt)) }); } catch (_) {}
            if (!vote) vote = await votesCol.findOne({ $or: [{ _id: String(voteIdInt) }, { id: String(voteIdInt) }] });
            if (!vote) return res.status(404).json({ error: 'Not Found', message: 'Vote not found.', code: 'VOTE_NOT_FOUND' });
            const vidStudent = vote.student_id ?? vote.studentId;
            const ownsVote = vidStudent != null && (
              String(vidStudent) === String(authenticatedStudentId) ||
              parseInt(vidStudent) === parseInt(authenticatedStudentId)
            );
            if (!ownsVote) return res.status(403).json({ error: 'Forbidden', message: 'Cannot access another student\'s vote receipt.', code: 'ACCESS_DENIED' });
            const recCol = client.db(getMongoDbName()).collection('vote_receipts');
            let rec = null;
            try { if (ObjectId.isValid(String(voteIdInt))) rec = await recCol.findOne({ vote_id: vote._id }); } catch (_) {}
            if (!rec) rec = await recCol.findOne({ $or: [{ vote_id: String(voteIdInt) }, { voteId: String(voteIdInt) }, { vote_id: voteIdInt }] });
            let receipt;
            if (rec) receipt = { receiptId: rec._id ? String(rec._id) : rec.id, receiptHash: rec.receipt_hash ?? rec.receiptHash, nullifier: rec.nullifier, createdAt: rec.created_at ?? rec.createdAt };
            else receipt = await voteService.generateReceipt(vote._id ? String(vote._id) : voteIdInt, electionIdInt, vidStudent);
            return res.json({ data: { receipt } });
          }
        } catch (e) {
          console.warn('voteController.getReceipt mongo fallback failed:', e.message);
        }
        return res.status(404).json({ error: 'Not Found', message: 'Vote not found.', code: 'VOTE_NOT_FOUND' });
      }
      // SECURITY: Ownership check - only allow access to own receipts
      const result = await db.query(
        `SELECT v.*, c.name as candidate_name, p.name as position_name,
                 e.name as election_name
         FROM votes v
         JOIN candidates c ON c.id = v.candidate_id
         JOIN positions p ON p.id = v.position_id
         JOIN elections e ON e.id = v.election_id
         WHERE v.id = $1 AND v.election_id = $2`,
        [voteIdInt, electionIdInt]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Vote not found.',
          code: 'VOTE_NOT_FOUND',
        });
      }

      const vote = result.rows[0];

      // SECURITY: Ownership check - student can only see their own receipt
      if (vote.student_id !== authenticatedStudentId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot access another student\'s vote receipt.',
          code: 'ACCESS_DENIED',
        });
      }

      // Fetch the existing stored receipt (created at vote time) - do NOT regenerate
      const receiptResult = await db.query(
        `SELECT id, receipt_hash, nullifier, created_at
         FROM vote_receipts
         WHERE vote_id = $1`,
        [voteIdInt]
      );

      let receipt;
      if (receiptResult.rows.length > 0) {
        receipt = {
          receiptId: receiptResult.rows[0].id,
          receiptHash: receiptResult.rows[0].receipt_hash,
          nullifier: receiptResult.rows[0].nullifier,
          createdAt: receiptResult.rows[0].created_at,
        };
      } else {
        // Backward compatibility: no stored receipt, return a one-time digest without persisting
        receipt = await voteService.generateReceipt(vote.id, electionIdInt, vote.student_id);
      }

      res.json({
        data: {
          receipt,
        },
      });

    } catch (err) {
      next(err);
    }
  }
}

// Helper to safely handle an id (numeric strings parse to ints, Mongo hex stays)
function parseToInt(val) {
  return resolveId(val);
}

module.exports = new VoteController();
