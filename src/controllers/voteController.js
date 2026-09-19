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

      // Parse IDs
      const constituencyId = parseToInt(constituency_id);
      const positionId = parseToInt(position_id);
      const candidateId = parseToInt(candidate_id);
      const electionIdInt = parseToInt(electionId);

      // Validate formats
      if ([positionId, candidateId, electionIdInt].some(isNaN)) {
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

      const electionIdInt = parseToInt(electionId);
      if (isNaN(electionIdInt)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid electionId format.',
        });
      }

      // Parse position_ids if provided
      let positionIdList = null;
      if (position_ids) {
        positionIdList = position_ids.split(',').map(id => parseInt(id));
        if (positionIdList.some(isNaN)) {
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

      const electionIdInt = parseToInt(electionId);
      if (isNaN(electionIdInt)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid electionId format.',
        });
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
        year: row.year_or_semester,
        section: row.section || '',
      });

      res.json({ data: { constituency } });
    } catch (err) {
      next(err);
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

      const electionIdInt = parseToInt(electionId);

      if (isNaN(electionIdInt)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid ID format.',
        });
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

      const electionIdInt = parseToInt(electionId);
      const voteIdInt = parseToInt(voteId);

      if (isNaN(electionIdInt) || isNaN(voteIdInt)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid ID format.',
        });
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

// Helper to safely parse int
function parseToInt(val) {
  const parsed = parseInt(val);
  return isNaN(parsed) ? val : parsed;
}

module.exports = new VoteController();
