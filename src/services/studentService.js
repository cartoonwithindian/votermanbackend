/**
 * Student Service
 * Business logic for student management
 */

const db = require('../db');

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
    const { name, email, voting_eligible, role, department, year_or_semester, section } = data;

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
