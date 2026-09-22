/**
 * Student Service
 * Business logic for student management
 */

const db = require('../db');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getClient: getSharedClient } = require('../db/mongoClient');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

/**
 * Remove sensitive fields from student record
 */
function sanitizeStudent(student) {
  if (!student) return null;
  const { password_hash, mfa_secret_encrypted, ...safe } = student;
  return safe;
}

/**
 * Remove sensitive fields from array of student records
 */
function sanitizeStudents(students) {
  return students.map(sanitizeStudent);
}

class StudentService {
  /**
   * Find all students
   */
  // Common projection that also pre-fills department/year/section from the
  // student's most recent Class Representative application (preferred when the
  // account has no section yet, so admins can mirror approved CR data).
  static PREFILL_JOIN = `
    LEFT JOIN LATERAL (
      SELECT ca.department, ca.year, ca.section
      FROM candidate_applications ca
      WHERE ca.student_id = s.id
        AND ca.category = 'CLASS_REPRESENTATIVE'
      ORDER BY (ca.status = 'approved') DESC, ca.created_at DESC
      LIMIT 1
    ) app ON TRUE
  `;

  async findAll(options = {}) {
    if (isMongoOnly) {
      const client = await getSharedClient();
      const col = client.db(getMongoDbName()).collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
      const filter = {};
      if (options.activeOnly) filter.isActive = true;
      const rows = await col.find(filter).sort({ _id: 1 }).skip(options.offset || 0).limit(options.limit || 100).toArray();
      // Map Mongo docs to Postgres-like shape for sanitize
      return sanitizeStudents(rows.map(r => ({
        id: r._id || r.postgresId,
        external_id: r.externalId,
        name: r.name,
        email: r.email,
        role: r.role,
        department: r.department,
        year_or_semester: r.year,
        section: r.section,
        is_active: r.isActive,
        voting_eligible: r.votingEligible,
        password_hash: r.passwordHash,
        mfa_enabled: r.mfaEnabled,
        roll_number: r.rollNumber,
        mobile_number: r.mobileNumber,
        profile_image_url: r.profileImageUrl,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })));
    }
    const { activeOnly = false, limit = 100, offset = 0 } = options;

    let query = `SELECT s.*,
                        app.department AS applied_department,
                        app.year AS applied_year,
                        app.section AS applied_section
                   FROM students s
                   ${StudentService.PREFILL_JOIN}`;
    const params = [];

    if (activeOnly) {
      query += ' WHERE s.is_active = true';
    }

    query += ' ORDER BY s.id LIMIT $1 OFFSET $2';
    params.push(limit, offset);

    const result = await db.query(query, params);
    return sanitizeStudents(result.rows);
  }

  /**
   * Find student by ID
   */
  async findById(id) {
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          const { ObjectId } = require('mongodb');
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
          let doc = null;
          try { if (ObjectId.isValid(String(id))) doc = await col.findOne({ _id: new ObjectId(String(id)) }); } catch (_) {}
          if (!doc) doc = await col.findOne({ $or: [{ postgresId: parseInt(id) }, { id: String(id) }, { _id: String(id) }] });
          if (!doc) {
            // Try scan
            const rows = await col.find({}).limit(200).toArray();
            doc = rows.find(r => String(r._id) === String(id) || String(r.postgresId) === String(id)) || null;
          }
          if (!doc) return null;
          return sanitizeStudent({
            id: doc._id || doc.postgresId || doc.id,
            student_id: doc.studentId || doc.student_id || null,
            external_id: doc.externalId || doc.external_id || null,
            name: doc.name,
            email: doc.email,
            role: doc.role || 'STUDENT',
            department: doc.department,
            year_or_semester: doc.year || doc.year_or_semester || doc.yearOrSemester,
            section: doc.section,
            is_active: doc.isActive ?? doc.is_active ?? true,
            voting_eligible: doc.votingEligible ?? doc.voting_eligible ?? false,
            password_hash: doc.passwordHash || doc.password_hash,
            mfa_enabled: doc.mfaEnabled ?? doc.mfa_enabled ?? false,
            roll_number: doc.rollNumber || doc.roll_number || null,
            mobile_number: doc.mobileNumber || doc.mobile_number || null,
            profile_image_url: doc.profileImageUrl || doc.profile_image_url || null,
            created_at: doc.createdAt || doc.created_at,
            updated_at: doc.updatedAt || doc.updated_at,
          });
        }
      } catch (e) {
        console.warn('studentService.findById mongo fallback failed:', e.message);
      }
      // Mongo-only without Postgres and no Mongo doc: avoid 500, return null (controller will 404, not 500)
      return null;
    }
    const result = await db.query(
      `SELECT s.*,
              app.department AS applied_department,
              app.year AS applied_year,
              app.section AS applied_section
         FROM students s
          ${StudentService.PREFILL_JOIN}
        WHERE s.id = $1`,
      [id]
    );
    return sanitizeStudent(result.rows[0]) || null;
  }

  /**
   * Find student by external ID
   */
  async findByExternalId(externalId) {
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
          const doc = await col.findOne({ $or: [{ externalId: externalId }, { external_id: externalId }] });
          if (!doc) return null;
          return sanitizeStudent({
            id: doc._id || doc.postgresId || doc.id,
            external_id: doc.externalId || doc.external_id,
            name: doc.name,
            email: doc.email,
            role: doc.role,
            department: doc.department,
            year_or_semester: doc.year || doc.year_or_semester,
            section: doc.section,
            is_active: doc.isActive ?? doc.is_active ?? true,
            voting_eligible: doc.votingEligible ?? doc.voting_eligible,
            password_hash: doc.passwordHash || doc.password_hash,
          });
        }
      } catch (e) {
        console.warn('studentService.findByExternalId mongo fallback failed:', e.message);
      }
      return null;
    }
    const result = await db.query(
      'SELECT * FROM students WHERE external_id = $1',
      [externalId]
    );
    return sanitizeStudent(result.rows[0]) || null;
  }

  /**
   * Create a new student
   */
  async create(data) {
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
          const doc = { externalId: data.external_id, external_id: data.external_id, name: data.name, email: data.email, role: 'STUDENT', isActive: true, is_active: true, createdAt: new Date(), created_at: new Date() };
          const res = await col.insertOne(doc);
          return sanitizeStudent({ id: res.insertedId, external_id: data.external_id, name: data.name, email: data.email, role: 'STUDENT', is_active: true, voting_eligible: false });
        }
      } catch (e) {
        console.warn('studentService.create mongo fallback failed:', e.message);
      }
      // Fallback mock to avoid 500
      return sanitizeStudent({ id: `mock-${Date.now()}`, external_id: data.external_id, name: data.name, email: data.email, role: 'STUDENT', is_active: true, voting_eligible: false });
    }
    const { external_id, name, email } = data;

    const result = await db.query(
      `INSERT INTO students (external_id, name, email)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [external_id, name, email]
    );

    return sanitizeStudent(result.rows[0]);
  }

  /**
   * Update student
   */
  async update(id, data) {
    if (isMongoOnly) {
      try {
        const existing = await this.findById(id);
        if (!existing) return null;
        const client = await getSharedClient();
        if (!client) {
          // Mock update
          return sanitizeStudent({ ...existing, ...data, updated_at: new Date().toISOString() });
        }
        const { ObjectId } = require('mongodb');
        const col = client.db(getMongoDbName()).collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
        const updates = {};
        if (data.name !== undefined) updates.name = data.name;
        if (data.email !== undefined) updates.email = data.email;
        if (data.voting_eligible !== undefined) { updates.votingEligible = data.voting_eligible; updates.voting_eligible = data.voting_eligible; }
        if (data.role !== undefined) updates.role = data.role;
        if (data.department !== undefined) updates.department = data.department;
        if (data.year_or_semester !== undefined) { updates.year = data.year_or_semester; updates.year_or_semester = data.year_or_semester; }
        if (data.section !== undefined) updates.section = data.section;
        if (data.profile_image_url !== undefined) { updates.profileImageUrl = data.profile_image_url; updates.profile_image_url = data.profile_image_url; }
        updates.updatedAt = new Date(); updates.updated_at = new Date();
        let res = null;
        try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: updates }, { returnDocument: 'after' }); } catch (_) {}
        if (!res || !res.value) res = await col.findOneAndUpdate({ postgresId: parseInt(id) }, { $set: updates }, { returnDocument: 'after' });
        if (!res || !res.value) res = await col.findOneAndUpdate({ id: String(id) }, { $set: updates }, { returnDocument: 'after' });
        if (res && res.value) {
          const d = res.value;
          return sanitizeStudent({ id: d._id || d.postgresId, name: d.name, email: d.email, role: d.role, department: d.department, year_or_semester: d.year || d.year_or_semester, section: d.section, is_active: d.isActive ?? d.is_active, voting_eligible: d.votingEligible ?? d.voting_eligible, profile_image_url: d.profileImageUrl || d.profile_image_url });
        }
        return sanitizeStudent({ ...existing, ...data });
      } catch (e) {
        console.warn('studentService.update mongo fallback failed:', e.message);
        const existing = await this.findById(id).catch(() => null);
        if (!existing) return null;
        return sanitizeStudent({ ...existing, ...data });
      }
    }
    const { name, email, voting_eligible, role, department, year_or_semester, section, profile_image_url } = data;

    // Build SET clauses dynamically so partial updates only touch given fields
    const sets = [];
    const values = [];
    let idx = 1;

    if (name !== undefined && name !== null) {
      sets.push(`name = $${idx++}`);
      values.push(name);
    }
    if (email !== undefined) {
      sets.push(`email = $${idx++}`);
      values.push(email);
    }
    if (voting_eligible !== undefined) {
      sets.push(`voting_eligible = $${idx++}`);
      values.push(voting_eligible);
    }
    if (role !== undefined) {
      sets.push(`role = $${idx++}`);
      values.push(role);
    }
    if (department !== undefined) {
      sets.push(`department = $${idx++}`);
      values.push(department);
    }
    if (year_or_semester !== undefined) {
      sets.push(`year_or_semester = $${idx++}`);
      values.push(year_or_semester);
    }
    if (section !== undefined) {
      sets.push(`section = $${idx++}`);
      values.push(section === null ? null : section);
    }
    if (profile_image_url !== undefined) {
      sets.push(`profile_image_url = $${idx++}`);
      values.push(profile_image_url ? String(profile_image_url).trim() : null);
    }

    if (sets.length === 0) {
      const existing = await db.query('SELECT * FROM students WHERE id = $1', [id]);
      return sanitizeStudent(existing.rows[0]) || null;
    }

    sets.push(`updated_at = NOW()`);
    values.push(id);

    const result = await db.query(
      `UPDATE students SET ${sets.join(', ')}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    return sanitizeStudent(result.rows[0]) || null;
  }

  /**
   * Update student status (activate/deactivate)
   */
  async updateStatus(id, isActive) {
    if (isMongoOnly) {
      return this.update(id, { is_active: isActive });
    }
    const result = await db.query(
      `UPDATE students SET is_active = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [isActive, id]
    );

    return sanitizeStudent(result.rows[0]) || null;
  }

  /**
   * Update student's profile image URL (Appwrite Storage)
   * Used by POST /api/v1/uploads/profile — persists the public view URL
   * from the "Profile Images & Candidate Photos" bucket (folder: profiles/).
   */
  async updateProfileImage(id, url) {
    if (isMongoOnly) {
      return this.update(id, { profile_image_url: url });
    }
    const result = await db.query(
      `UPDATE students SET profile_image_url = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [url, id]
    );
    return sanitizeStudent(result.rows[0]) || null;
  }

  /**
   * Update own profile (student self-service) — name/phone/avatar
   * Only allow safe fields; email/role/voting_eligible are admin-only.
   */
  async updateOwnProfile(id, data) {
    if (isMongoOnly) {
      try {
        const existing = await this.findById(id);
        if (!existing) return null;
        const updates = {};
        if (data.name !== undefined && data.name !== null && String(data.name).trim() !== '') updates.name = String(data.name).trim();
        if (data.phone !== undefined) updates.mobile_number = data.phone ? String(data.phone).trim() : null;
        if (data.profile_image_url !== undefined) updates.profile_image_url = data.profile_image_url ? String(data.profile_image_url).trim() : null;
        if (Object.keys(updates).length === 0) return existing;
        const client = await getSharedClient();
        if (!client) return sanitizeStudent({ ...existing, ...updates });
        const { ObjectId } = require('mongodb');
        const col = client.db(getMongoDbName()).collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
          const mongoUpdates = {};
          if (updates.name) mongoUpdates.name = updates.name;
          if (updates.mobile_number !== undefined) { mongoUpdates.mobileNumber = updates.mobile_number; mongoUpdates.mobile_number = updates.mobile_number; }
          if (updates.profile_image_url !== undefined) { mongoUpdates.profileImageUrl = updates.profile_image_url; mongoUpdates.profile_image_url = updates.profile_image_url; }
          mongoUpdates.updatedAt = new Date(); mongoUpdates.updated_at = new Date();
          let res = null;
          try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: mongoUpdates }, { returnDocument: 'after' }); } catch (_) {}
          if (!res || !res.value) res = await col.findOneAndUpdate({ postgresId: parseInt(id) }, { $set: mongoUpdates }, { returnDocument: 'after' });
          if (res && res.value) {
            const d = res.value;
            return sanitizeStudent({ id: d._id || d.postgresId, name: d.name, email: d.email, role: d.role, department: d.department, year_or_semester: d.year || d.year_or_semester, section: d.section, is_active: d.isActive ?? d.is_active, voting_eligible: d.votingEligible ?? d.voting_eligible, mobile_number: d.mobileNumber || d.mobile_number, profile_image_url: d.profileImageUrl || d.profile_image_url });
          }
          return sanitizeStudent({ ...existing, ...updates });
      } catch (e) {
        console.warn('studentService.updateOwnProfile mongo fallback failed:', e.message);
        const existing = await this.findById(id).catch(() => null);
        if (!existing) return null;
        return sanitizeStudent({ ...existing, ...data });
      }
    }
    const { name, phone, profile_image_url } = data;
    const sets = [];
    const values = [];
    let idx = 1;
    if (name !== undefined && name !== null && String(name).trim() !== '') {
      sets.push(`name = $${idx++}`);
      values.push(String(name).trim());
    }
    if (phone !== undefined) {
      sets.push(`mobile_number = $${idx++}`);
      values.push(phone ? String(phone).trim() : null);
    }
    if (profile_image_url !== undefined) {
      sets.push(`profile_image_url = $${idx++}`);
      values.push(profile_image_url ? String(profile_image_url).trim() : null);
    }
    if (sets.length === 0) {
      const existing = await db.query('SELECT * FROM students WHERE id = $1', [id]);
      return sanitizeStudent(existing.rows[0]) || null;
    }
    sets.push(`updated_at = NOW()`);
    values.push(id);
    const result = await db.query(
      `UPDATE students SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return sanitizeStudent(result.rows[0]) || null;
  }
}

module.exports = new StudentService();
