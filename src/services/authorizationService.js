/**
 * Authorization Service
 * Business logic for voter authorization management
 */

const db = require('../db');

class AuthorizationService {
  /**
   * Find all authorizations for an election
   */
  async findByElectionId(electionId, options = {}) {
    const { activeOnly = true, limit = 100, offset = 0 } = options;

    let query = `
      SELECT va.*,
             s.external_id, s.name as student_name, s.email as student_email,
             e.name as election_name, e.status as election_status
      FROM voter_authorizations va
      JOIN students s ON va.student_id = s.id
      JOIN elections e ON va.election_id = e.id
      WHERE va.election_id = $1
    `;
    const params = [electionId];

    if (activeOnly) {
      query += ' AND va.is_authorized = true';
    }

    query += ' ORDER BY s.name LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Find authorization by ID
   */
  async findById(id) {
    const result = await db.query(
      `SELECT va.*,
              s.external_id, s.name as student_name, s.email as student_email,
              e.name as election_name, e.status as election_status
       FROM voter_authorizations va
       JOIN students s ON va.student_id = s.id
       JOIN elections e ON va.election_id = e.id
       WHERE va.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Find authorization by ID (simple)
   */
  async findByIdSimple(id) {
    const result = await db.query(
      'SELECT * FROM voter_authorizations WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Check if an authorization exists for student/election
   */
  async exists(studentId, electionId) {
    const result = await db.query(
      'SELECT id FROM voter_authorizations WHERE student_id = $1 AND election_id = $2',
      [studentId, electionId]
    );
    return result.rows.length > 0;
  }

  /**
   * Create a new authorization (election-wide)
   */
  async create(data) {
    const { student_id, election_id, is_authorized = true, expires_at } = data;

    const result = await db.query(
      `INSERT INTO voter_authorizations (student_id, election_id, is_authorized, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        student_id,
        election_id,
        is_authorized,
        expires_at || null,
      ]
    );

    return result.rows[0];
  }

  /**
   * Update an authorization
   */
  async update(id, data) {
    const { is_authorized, expires_at } = data;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (is_authorized !== undefined) {
      updates.push(`is_authorized = $${paramIndex}`);
      params.push(is_authorized);
      paramIndex++;
    }

    if (expires_at !== undefined) {
      updates.push(`expires_at = $${paramIndex}`);
      params.push(expires_at);
      paramIndex++;
    }

    if (updates.length === 0) {
      return this.findByIdSimple(id);
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const query = `UPDATE voter_authorizations SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await db.query(query, params);
    return result.rows[0];
  }

  /**
   * Delete an authorization
   */
  async delete(id) {
    const result = await db.query(
      'DELETE FROM voter_authorizations WHERE id = $1 RETURNING id',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Check if student exists and is active
   */
  async studentExistsAndActive(studentId) {
    const result = await db.query(
      'SELECT is_active FROM students WHERE id = $1',
      [studentId]
    );
    return result.rows.length > 0 && result.rows[0].is_active === true;
  }

  /**
   * Check if student exists (regardless of active status)
   */
  async studentExists(studentId) {
    const result = await db.query(
      'SELECT id FROM students WHERE id = $1',
      [studentId]
    );
    return result.rows.length > 0;
  }

  /**
   * Check if election exists
   */
  async electionExists(electionId) {
    const result = await db.query(
      'SELECT id, status FROM elections WHERE id = $1',
      [electionId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get election status
   */
  async getElectionStatus(electionId) {
    const result = await db.query(
      'SELECT status FROM elections WHERE id = $1',
      [electionId]
    );
    return result.rows[0]?.status || null;
  }

  /**
   * Get full election by ID
   */
  async getElectionById(electionId) {
    const result = await db.query(
      'SELECT * FROM elections WHERE id = $1',
      [electionId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get student by ID
   */
  async getStudentById(studentId) {
    const result = await db.query(
      'SELECT * FROM students WHERE id = $1',
      [studentId]
    );
    return result.rows[0] || null;
  }

/**
   * Get election status for an authorization
   */
  async getAuthorizationElectionStatus(authorizationId) {
    const result = await db.query(
      `SELECT e.status FROM elections e
       JOIN voter_authorizations va ON va.election_id = e.id
       WHERE va.id = $1`,
      [authorizationId]
    );
    return result.rows[0]?.status || null;
  }

  /**
   * Check if authorization can be modified based on election state
   * Returns: { canModify: boolean, reason: string }
   */
  async canModify(authorizationId) {
    const auth = await this.findByIdSimple(authorizationId);
    if (!auth) return { canModify: false, reason: 'Authorization not found' };

    const status = await this.getElectionStatus(auth.election_id);

    if (status === 'OPEN') {
      // During voting, we allow deactivation but not creation of new authorizations
      // The PATCH endpoint handles this distinction
      return { canModify: true, reason: 'Can modify during OPEN but changes may affect voting' };
    }

    if (status === 'CLOSED') {
      return { canModify: false, reason: 'Cannot modify authorizations when election is CLOSED' };
    }

    return { canModify: true, reason: 'Can modify in DRAFT or SCHEDULED state' };
  }

  /**
   * Check if authorization can be created for an election
   */
  async canCreate(electionId) {
    const status = await this.getElectionStatus(electionId);

    if (status === 'OPEN') {
      return { canCreate: false, reason: 'Cannot create authorizations when election is OPEN' };
    }

    if (status === 'CLOSED') {
      return { canCreate: false, reason: 'Cannot create authorizations when election is CLOSED' };
    }

    return { canCreate: true, reason: 'Can create in DRAFT or SCHEDULED state' };
  }

  /**
   * Check if authorization can be deleted
   */
  async canDelete(authorizationId) {
    const auth = await this.findByIdSimple(authorizationId);
    if (!auth) return { canDelete: false, reason: 'Authorization not found' };

    const status = await this.getElectionStatus(auth.election_id);

    if (status === 'OPEN') {
      // Warn but allow - voter might need to be excluded
      return { canDelete: true, warning: 'Deleting authorization during OPEN may affect voting integrity' };
    }

    if (status === 'CLOSED') {
      return { canDelete: false, reason: 'Cannot delete authorizations when election is CLOSED' };
    }

    return { canDelete: true, reason: 'Can delete in DRAFT or SCHEDULED state' };
  }

  /**
   * Check student eligibility for an election
   * Returns detailed eligibility information
   */
  async checkEligibility(studentId, electionId) {
    // Check student exists
    const student = await db.query(
      'SELECT id, is_active FROM students WHERE id = $1',
      [studentId]
    );

    if (student.rows.length === 0) {
      return {
        eligible: false,
        reason: 'STUDENT_NOT_FOUND',
        message: 'Student does not exist',
      };
    }

    // Check student is active
    if (!student.rows[0].is_active) {
      return {
        eligible: false,
        reason: 'STUDENT_INACTIVE',
        message: 'Student is not active',
      };
    }

    // Check election exists
    const election = await db.query(
      'SELECT id, status, name FROM elections WHERE id = $1',
      [electionId]
    );

    if (election.rows.length === 0) {
      return {
        eligible: false,
        reason: 'ELECTION_NOT_FOUND',
        message: 'Election does not exist',
      };
    }

    // Check election is in valid state
    const validStates = ['DRAFT', 'SCHEDULED', 'OPEN'];
    if (!validStates.includes(election.rows[0].status)) {
      return {
        eligible: false,
        reason: 'ELECTION_NOT_ACTIVE',
        message: `Election is ${election.rows[0].status}`,
      };
    }

    // Check for active authorization (election-wide — the only kind now)
    const auth = await db.query(
      `SELECT va.id
       FROM voter_authorizations va
       WHERE va.student_id = $1
         AND va.election_id = $2
         AND va.is_authorized = true
         AND (va.expires_at IS NULL OR va.expires_at > NOW())`,
      [studentId, electionId]
    );

    if (auth.rows.length === 0) {
      return {
        eligible: false,
        reason: 'NOT_AUTHORIZED',
        message: 'Student is not authorized for this election',
        student_id: studentId,
        election_id: electionId,
      };
    }

    return {
      eligible: true,
      reason: 'AUTHORIZED',
      message: 'Student is authorized',
      student_id: studentId,
      election_id: electionId,
      election_status: election.rows[0].status,
      authorized_clubs: [],
      full_access: true,
    };
  }
}

module.exports = new AuthorizationService();
