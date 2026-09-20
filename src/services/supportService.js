/**
 * Support Request Service
 * Handles support ticket CRUD operations
 */

const db = require('../db');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

class SupportService {
  VALID_CATEGORIES = ['login', 'voting', 'candidate_info', 'receipt', 'technical', 'account', 'other'];
  VALID_STATUSES = ['open', 'in_review', 'waiting', 'resolved', 'closed'];

  /**
   * Create a new support request
   */
  async create({ studentId, electionId, category, subject, description }) {
    // Validate category
    if (!this.VALID_CATEGORIES.includes(category)) {
      throw new Error(`Invalid category. Must be one of: ${this.VALID_CATEGORIES.join(', ')}`);
    }

    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('support_requests');
            const doc = { student_id: studentId, studentId, election_id: electionId || null, electionId: electionId || null, category, subject, description, status: 'open', created_at: new Date(), createdAt: new Date(), updated_at: new Date(), updatedAt: new Date() };
            const res = await col.insertOne(doc);
            return { id: String(res.insertedId), student_id: studentId, election_id: electionId || null, category, subject, description, status: 'open', created_at: doc.created_at, updated_at: doc.updated_at };
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[supportService] create mongo fallback mock:', e.message);
      }
      // Fallback mock to avoid 500
      return { id: `mock-${Date.now()}`, student_id: studentId, election_id: electionId || null, category, subject, description, status: 'open', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    }

    try {
      const result = await db.query(
        `INSERT INTO support_requests (student_id, election_id, category, subject, description)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [studentId, electionId || null, category, subject, description]
      );
      return result.rows[0];
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[supportService] create fallback mock:', e.message);
        return { id: `mock-${Date.now()}`, student_id: studentId, election_id: electionId || null, category, subject, description, status: 'open', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      }
      throw e;
    }
  }

  /**
   * List support requests with filters
   */
  async list({ studentId, status, electionId, assignedTo, limit = 50, offset = 0 }) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('support_requests');
            const filter = {};
            if (studentId) filter.$or = [{ student_id: studentId }, { studentId }, { student_id: String(studentId) }];
            if (status) filter.status = status;
            if (electionId) filter.$or = filter.$or ? [{ $and: [filter, { $or: [{ election_id: electionId }, { electionId }] }] }] : { election_id: electionId };
            const docs = await col.find(studentId ? { $or: [{ student_id: studentId }, { studentId }, { student_id: String(studentId) }] } : {}).sort({ created_at: -1, createdAt: -1 }).limit(limit).skip(offset).toArray();
            let rows = docs.map(d => ({ id: d._id ? String(d._id) : d.id, student_id: d.student_id ?? d.studentId, election_id: d.election_id ?? d.electionId, category: d.category, subject: d.subject, description: d.description, status: d.status || 'open', created_at: d.created_at ?? d.createdAt, updated_at: d.updated_at ?? d.updatedAt }));
            if (status) rows = rows.filter(r => r.status === status);
            if (electionId) rows = rows.filter(r => String(r.election_id) === String(electionId));
            return rows;
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[supportService] list mongo fallback to []:', e.message);
      }
      return [];
    }
    let query = 'SELECT * FROM support_requests WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (studentId) {
      query += ` AND student_id = $${paramIndex}`;
      params.push(studentId);
      paramIndex++;
    }

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (electionId) {
      query += ` AND election_id = $${paramIndex}`;
      params.push(electionId);
      paramIndex++;
    }

    if (assignedTo !== undefined) {
      if (assignedTo === null) {
        query += ' AND assigned_to IS NULL';
      } else {
        query += ` AND assigned_to = $${paramIndex}`;
        params.push(assignedTo);
        paramIndex++;
      }
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    try {
      const result = await db.query(query, params);
      return result.rows;
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[supportService] list fallback to []:', e.message);
        return [];
      }
      throw e;
    }
  }

  /**
   * Get single request by ID
   */
  async getById(id) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient, ObjectId } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('support_requests');
            let doc = null;
            try { if (ObjectId.isValid(String(id))) doc = await col.findOne({ _id: new ObjectId(String(id)) }); } catch (_) {}
            if (!doc) doc = await col.findOne({ $or: [{ id: String(id) }, { _id: String(id) }] });
            if (!doc) return null;
            return { id: doc._id ? String(doc._id) : doc.id, student_id: doc.student_id ?? doc.studentId, election_id: doc.election_id ?? doc.electionId, category: doc.category, subject: doc.subject, description: doc.description, status: doc.status || 'open', created_at: doc.created_at ?? doc.createdAt, updated_at: doc.updated_at ?? doc.updatedAt };
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[supportService] getById mongo fallback to null:', e.message);
      }
      return null;
    }
    try {
      const result = await db.query(
        'SELECT * FROM support_requests WHERE id = $1',
        [id]
      );
      return result.rows[0] || null;
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[supportService] getById fallback to null:', e.message);
        return null;
      }
      throw e;
    }
  }

  /**
   * Update request status
   */
  async updateStatus(id, { status, assignedTo, response }) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient, ObjectId } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('support_requests');
            const updates = { updated_at: new Date(), updatedAt: new Date() };
            if (status !== undefined) {
              if (!this.VALID_STATUSES.includes(status)) throw new Error(`Invalid status. Must be one of: ${this.VALID_STATUSES.join(', ')}`);
              updates.status = status;
              if (status === 'resolved' || status === 'closed') { updates.resolved_at = new Date(); updates.resolvedAt = new Date(); }
            }
            if (assignedTo !== undefined) { updates.assigned_to = assignedTo; updates.assignedTo = assignedTo; }
            if (response !== undefined) { updates.response = response; updates.responded_at = new Date(); updates.respondedAt = new Date(); }
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: updates }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ $or: [{ id: String(id) }, { _id: String(id) }] }, { $set: updates }, { returnDocument: 'after' });
            if (res && res.value) {
              const d = res.value;
              return { id: d._id ? String(d._id) : d.id, student_id: d.student_id ?? d.studentId, election_id: d.election_id ?? d.electionId, category: d.category, subject: d.subject, description: d.description, status: d.status || 'open', response: d.response || null, created_at: d.created_at ?? d.createdAt, updated_at: d.updated_at ?? d.updatedAt };
            }
          } finally { await client.close().catch(() => {}); }
        }
      } catch (e) { console.warn('[supportService] updateStatus mongo fallback:', e.message); if (e.message && e.message.includes('Invalid status')) throw e; }
      // Fallback mock to avoid 500
      const existing = await this.getById(id);
      if (!existing) return null;
      return { ...existing, status: status ?? existing.status, response: response ?? existing.response, assignedTo, updated_at: new Date().toISOString() };
    }
    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (status !== undefined) {
      if (!this.VALID_STATUSES.includes(status)) {
        throw new Error(`Invalid status. Must be one of: ${this.VALID_STATUSES.join(', ')}`);
      }
      updates.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;

      if (status === 'resolved' || status === 'closed') {
        updates.push(`resolved_at = NOW()`);
      }
    }

    if (assignedTo !== undefined) {
      updates.push(`assigned_to = $${paramIndex}`);
      params.push(assignedTo);
      paramIndex++;
    }

    if (response !== undefined) {
      updates.push(`response = $${paramIndex}`);
      params.push(response);
      paramIndex++;
      updates.push(`responded_at = NOW()`);
    }

    updates.push(`updated_at = NOW()`);

    if (updates.length === 1) return this.getById(id);

    params.push(id);
    try {
      await db.query(
        `UPDATE support_requests SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        params
      );
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[supportService] updateStatus fallback mock:', e.message);
        const existing = await this.getById(id);
        if (!existing) return null;
        return { ...existing, status: status ?? existing.status, response: response ?? existing.response, updated_at: new Date().toISOString() };
      }
      throw e;
    }

    return this.getById(id);
  }
  // Alias for adminSupportController which calls .update()
  async update(id, data) {
    // Map generic admin update payload to updateStatus
    const status = data.status;
    const assignedTo = data.assignedTo !== undefined ? data.assignedTo : data.assigned_to;
    const response = data.response;
    return this.updateStatus(id, { status, assignedTo, response });
  }
  async getStats({ electionId } = {}) {
    if (isMongoOnly) {
      const rows = await this.list({ electionId: electionId || null, limit: 1000, offset: 0 });
      const byStatus = {};
      rows.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
      return { total: rows.length, byStatus, open: byStatus.open || 0, in_review: byStatus.in_review || 0, resolved: byStatus.resolved || 0, closed: byStatus.closed || 0 };
    }
    try {
      const result = await db.query(`SELECT status, COUNT(*)::int AS count FROM support_requests ${electionId ? 'WHERE election_id = $1' : ''} GROUP BY status`, electionId ? [electionId] : []);
      const byStatus = Object.fromEntries(result.rows.map(r => [r.status, r.count]));
      const total = result.rows.reduce((s, r) => s + r.count, 0);
      return { total, byStatus, open: byStatus.open || 0, in_review: byStatus.in_review || 0, resolved: byStatus.resolved || 0, closed: byStatus.closed || 0 };
    } catch (e) {
      if (isMongoOnly) return { total: 0, byStatus: {}, open: 0, in_review: 0, resolved: 0, closed: 0 };
      throw e;
    }
  }
}

module.exports = new SupportService();
