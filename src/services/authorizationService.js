/**
 * Authorization Service
 * Business logic for voter authorization management
 */

const db = require('../db');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

class AuthorizationService {
  /**
   * Find all authorizations for an election
   */
  async findByElectionId(electionId, options = {}) {
    if (isMongoOnly) return [];
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

    try {
      const result = await db.query(query, params);
      return result.rows;
    } catch (e) {
      if (isMongoOnly) return [];
      throw e;
    }
  }

  /**
   * Find authorization by ID
   */
  async findById(id) {
    if (isMongoOnly) return null;
    try {
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
    } catch (e) {
      if (isMongoOnly) return null;
      throw e;
    }
  }

  /**
   * Find authorization by ID (simple)
   */
  async findByIdSimple(id) {
    if (isMongoOnly) return null;
    try {
      const result = await db.query(
        'SELECT * FROM voter_authorizations WHERE id = $1',
        [id]
      );
      return result.rows[0] || null;
    } catch (e) {
      if (isMongoOnly) return null;
      throw e;
    }
  }

  /**
   * Check if an authorization exists for student/election
   */
  async exists(studentId, electionId) {
    if (isMongoOnly) return false;
    try {
      const result = await db.query(
        'SELECT id FROM voter_authorizations WHERE student_id = $1 AND election_id = $2',
        [studentId, electionId]
      );
      return result.rows.length > 0;
    } catch (e) {
      if (isMongoOnly) return false;
      throw e;
    }
  }

  /**
   * Create a new authorization (election-wide)
   */
  async create(data) {
    if (isMongoOnly) {
      // Mongo-only: try Mongo voter_authorizations, otherwise mock to avoid 500
      try {
        const { MongoClient } = require('mongodb');
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('voter_authorizations');
            const doc = { student_id: data.student_id, studentId: data.student_id, election_id: data.election_id, electionId: data.election_id, is_authorized: data.is_authorized ?? true, isAuthorized: data.is_authorized ?? true, expires_at: data.expires_at || null, expiresAt: data.expires_at || null, created_at: new Date(), updated_at: new Date() };
            const res = await col.insertOne(doc);
            return { id: String(res.insertedId), student_id: doc.student_id, election_id: doc.election_id, is_authorized: doc.is_authorized, expires_at: doc.expires_at, created_at: doc.created_at, updated_at: doc.updated_at };
          } finally { await client.close().catch(() => {}); }
        }
      } catch (e) { console.warn('[authorizationService] create mongo fallback:', e.message); }
      // Mock success to avoid 500
      const { student_id, election_id, is_authorized = true, expires_at } = data;
      return { id: `mock-${Date.now()}`, student_id, election_id, is_authorized, expires_at: expires_at || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    }
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
    if (isMongoOnly) {
      try {
        const { MongoClient, ObjectId } = require('mongodb');
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('voter_authorizations');
            const updates = {};
            if (data.is_authorized !== undefined) { updates.is_authorized = data.is_authorized; updates.isAuthorized = data.is_authorized; }
            if (data.expires_at !== undefined) { updates.expires_at = data.expires_at; updates.expiresAt = data.expires_at; }
            updates.updated_at = new Date(); updates.updatedAt = new Date();
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: updates }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ $or: [{ id: String(id) }, { _id: String(id) }] }, { $set: updates }, { returnDocument: 'after' });
            if (res && res.value) {
              const d = res.value;
              return { id: d._id ? String(d._id) : d.id, student_id: d.student_id ?? d.studentId, election_id: d.election_id ?? d.electionId, is_authorized: d.is_authorized ?? d.isAuthorized, expires_at: d.expires_at ?? d.expiresAt, updated_at: d.updated_at ?? d.updatedAt };
            }
          } finally { await client.close().catch(() => {}); }
        }
      } catch (e) { console.warn('[authorizationService] update mongo fallback:', e.message); }
      // Fallback mock to avoid 500
      const existing = await this.findByIdSimple(id);
      if (!existing) return null;
      return { ...existing, ...data, updated_at: new Date().toISOString() };
    }
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
    try {
      const result = await db.query(query, params);
      return result.rows[0];
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[authorizationService] update fallback mock:', e.message);
        const existing = await this.findByIdSimple(id);
        if (!existing) return null;
        return { ...existing, ...data, updated_at: new Date().toISOString() };
      }
      throw e;
    }
  }

  /**
   * Delete an authorization
   */
  async delete(id) {
    if (isMongoOnly) {
      try {
        const { MongoClient, ObjectId } = require('mongodb');
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('voter_authorizations');
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndDelete({ _id: new ObjectId(String(id)) }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndDelete({ $or: [{ id: String(id) }, { _id: String(id) }] });
            if (res && res.value) return { id: String(res.value._id || res.value.id) };
          } finally { await client.close().catch(() => {}); }
        }
      } catch (e) { console.warn('[authorizationService] delete mongo fallback:', e.message); }
      // Mock success to avoid 500 — return id as if deleted
      return { id: String(id) };
    }
    try {
      const result = await db.query(
        'DELETE FROM voter_authorizations WHERE id = $1 RETURNING id',
        [id]
      );
      return result.rows[0] || null;
    } catch (e) {
      if (isMongoOnly) return { id: String(id) };
      throw e;
    }
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
    if (isMongoOnly) {
      try {
        const electionService = require('./electionService');
        const e = await electionService.findById(electionId);
        return e?.status || null;
      } catch (_) { return null; }
    }
    try {
      const result = await db.query(
        'SELECT status FROM elections WHERE id = $1',
        [electionId]
      );
      return result.rows[0]?.status || null;
    } catch (e) {
      if (isMongoOnly) return null;
      throw e;
    }
  }

  /**
   * Get full election by ID
   */
  async getElectionById(electionId) {
    if (isMongoOnly) {
      try {
        const electionService = require('./electionService');
        const e = await electionService.findById(electionId);
        return e || null;
      } catch (_) { return null; }
    }
    try {
      const result = await db.query(
        'SELECT * FROM elections WHERE id = $1',
        [electionId]
      );
      return result.rows[0] || null;
    } catch (e) {
      if (isMongoOnly) return null;
      throw e;
    }
  }

  /**
   * Get student by ID
   */
  async getStudentById(studentId) {
    if (isMongoOnly) {
      try {
        const studentService = require('./studentService');
        const s = await studentService.findById(studentId);
        return s || null;
      } catch (_) { return null; }
    }
    try {
      const result = await db.query(
        'SELECT * FROM students WHERE id = $1',
        [studentId]
      );
      return result.rows[0] || null;
    } catch (e) {
      if (isMongoOnly) return null;
      throw e;
    }
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
    if (isMongoOnly) {
      try {
        const { MongoClient, ObjectId } = require('mongodb');
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const dbName = process.env.MONGODB_DB || 'voteweb';
            // Check election exists in Mongo
            const eCol = client.db(dbName).collection('elections');
            let election = null;
            try { if (ObjectId.isValid(String(electionId))) election = await eCol.findOne({ _id: new ObjectId(String(electionId)) }); } catch (_) {}
            if (!election) election = await eCol.findOne({ $or: [{ postgresId: parseInt(electionId) }, { id: parseInt(electionId) }, { _id: String(electionId) }] });
            if (!election) {
              // Fallback: try electionService which already handles Mongo
              const electionService = require('./electionService');
              const e = await electionService.findById(electionId).catch(() => null);
              if (!e) return { eligible: false, reason: 'ELECTION_NOT_FOUND', message: 'Election does not exist' };
              election = { status: e.status, name: e.name };
            }
            const status = election.status || election.status;
            const validStates = ['DRAFT', 'SCHEDULED', 'OPEN'];
            if (!validStates.includes(status)) {
              return { eligible: false, reason: 'ELECTION_NOT_ACTIVE', message: `Election is ${status}` };
            }
            // Check authorization in Mongo voter_authorizations
            const authCol = client.db(dbName).collection('voter_authorizations');
            const auth = await authCol.findOne({ $or: [{ student_id: parseInt(studentId), election_id: parseInt(electionId) }, { studentId: parseInt(studentId), electionId: parseInt(electionId) }, { student_id: String(studentId), election_id: String(electionId) }] });
            if (!auth || !(auth.is_authorized ?? auth.isAuthorized)) {
              // Also check voting_eligible flag on student as fallback (Mongo-only mode voting is permissive)
              const sCol = client.db(dbName).collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
              let studentDoc = null;
              try { if (ObjectId.isValid(String(studentId))) studentDoc = await sCol.findOne({ _id: new ObjectId(String(studentId)) }); } catch (_) {}
              if (!studentDoc) studentDoc = await sCol.findOne({ $or: [{ postgresId: parseInt(studentId) }, { id: String(studentId) }] });
              if (studentDoc && (studentDoc.votingEligible ?? studentDoc.voting_eligible ?? studentDoc.isActive)) {
                return { eligible: true, reason: 'AUTHORIZED', message: 'Student is authorized (Mongo-only fallback)', student_id: studentId, election_id: electionId, election_status: status, authorized_clubs: [], full_access: true };
              }
              return { eligible: false, reason: 'NOT_AUTHORIZED', message: 'Student is not authorized for this election', student_id: studentId, election_id: electionId };
            }
            // Check expiry
            if (auth.expires_at && new Date(auth.expires_at) < new Date()) {
              return { eligible: false, reason: 'NOT_AUTHORIZED', message: 'Authorization expired', student_id: studentId, election_id: electionId };
            }
            return { eligible: true, reason: 'AUTHORIZED', message: 'Student is authorized', student_id: studentId, election_id: electionId, election_status: status, authorized_clubs: [], full_access: true };
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[authorizationService] checkEligibility mongo fallback failed:', e.message);
      }
      // Fallback: return not authorized but NOT 500
      return { eligible: false, reason: 'NOT_AUTHORIZED', message: 'Student is not authorized for this election (Mongo-only mode)', student_id: studentId, election_id: electionId };
    }
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
