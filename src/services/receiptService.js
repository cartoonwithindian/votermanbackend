/**
 * Vote Receipt Service
 * Handles vote receipt generation and verification
 */

const crypto = require('crypto');
const db = require('../db');

class ReceiptService {
  /**
   * Generate a vote receipt after successful vote
   * @param {number} voteId - The vote ID
   * @param {number} electionId - The election ID
   * @param {number} studentId - The student ID
   * @returns {Promise<Object>} Receipt data
   */
  async generateReceipt(voteId, electionId, studentId) {
    // Generate nullifier (unique per vote, prevents identification)
    const nullifier = this.generateNullifier();

    // Generate receipt hash from vote data
    const timestamp = new Date().toISOString();
    const hashInput = `${voteId}:${electionId}:${studentId}:${timestamp}:${nullifier}`;
    const receiptHash = this.hashData(hashInput);

    // Store receipt
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
      verificationUrl: `/verify/${result.rows[0].id}`,
    };
  }

  /**
   * Verify a vote receipt by ID
   * @param {string} receiptId - The receipt UUID
   * @returns {Promise<Object|null>} Receipt data or null if not found
   */
  async verifyReceipt(receiptId) {
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(receiptId)) {
      return { valid: false, error: 'Invalid receipt ID format' };
    }

    const result = await db.query(
      `SELECT
        vr.id,
        vr.receipt_hash,
        vr.created_at,
        vr.election_id,
        e.name as election_name,
        e.status as election_status
       FROM vote_receipts vr
       JOIN elections e ON vr.election_id = e.id
       WHERE vr.id = $1`,
      [receiptId]
    );

    if (result.rows.length === 0) {
      return { valid: false, error: 'Receipt not found' };
    }

    const receipt = result.rows[0];
    return {
      valid: true,
      receipt: {
        id: receipt.id,
        receiptHash: receipt.receipt_hash,
        createdAt: receipt.created_at,
        electionName: receipt.election_name,
        electionStatus: receipt.election_status,
      },
    };
  }

  /**
   * Get receipt for a student (private, requires auth)
   * @param {number} studentId - The student ID
   * @param {number} electionId - The election ID
   * @returns {Promise<Object|null>} Receipt or null
   */
  async getStudentReceipt(studentId, electionId) {
    const result = await db.query(
      `SELECT
        vr.id,
        vr.receipt_hash,
        vr.nullifier,
        vr.created_at,
        e.name as election_name
       FROM vote_receipts vr
       JOIN elections e ON vr.election_id = e.id
       WHERE vr.student_id = $1 AND vr.election_id = $2`,
      [studentId, electionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      receiptId: result.rows[0].id,
      electionName: result.rows[0].election_name,
      receiptHash: result.rows[0].receipt_hash,
      nullifier: result.rows[0].nullifier,
      createdAt: result.rows[0].created_at,
      verificationUrl: `/verify/${result.rows[0].id}`,
    };
  }

  /**
   * Check if a student has a receipt for an election
   * @param {number} studentId - The student ID
   * @param {number} electionId - The election ID
   * @returns {Promise<boolean>}
   */
  async hasReceipt(studentId, electionId) {
    const result = await db.query(
      `SELECT 1 FROM vote_receipts WHERE student_id = $1 AND election_id = $2`,
      [studentId, electionId]
    );
    return result.rows.length > 0;
  }

  /**
   * Get full receipt details for the authenticated student
   * Includes student name, vote choices, etc.
   * Enforces ownership by studentId
   * @param {number} studentId - The authenticated student ID
   * @param {number} electionId - The election ID
   * @returns {Promise<Object|null>}
   */
  async getFullReceiptDetails(studentId, electionId) {
    const result = await db.query(
      `SELECT
        vr.id as receipt_id,
        vr.receipt_hash,
        vr.nullifier,
        vr.created_at,
        vr.election_id,
        e.name as election_name,
        e.status as election_status,
        v.id as vote_id,
        v.student_id,
        st.name as student_name,
        p.name as position_name,
        ca.name as candidate_name
       FROM vote_receipts vr
       JOIN elections e ON vr.election_id = e.id
       JOIN votes v ON vr.vote_id = v.id
       JOIN students st ON v.student_id = st.id
       JOIN positions p ON v.position_id = p.id
       JOIN candidates ca ON v.candidate_id = ca.id
       WHERE vr.student_id = $1 AND vr.election_id = $2`,
      [studentId, electionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const r = result.rows[0];
    return {
      receiptId: r.receipt_id,
      receiptHash: r.receipt_hash,
      nullifier: r.nullifier,
      createdAt: r.created_at,
      electionId: r.election_id,
      electionName: r.election_name,
      electionStatus: r.election_status,
      voteId: r.vote_id,
      studentId: r.student_id,
      studentName: r.student_name,
      positionName: r.position_name,
      candidateName: r.candidate_name,
    };
  }

  /**
   * Generate a random nullifier
   * @returns {string}
   */
  generateNullifier() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Hash data using SHA-256
   * @param {string} data
   * @returns {string}
   */
  hashData(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}

module.exports = new ReceiptService();
