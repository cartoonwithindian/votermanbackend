/**
 * Student Controller
 * HTTP request handling for student management
 */

const studentService = require('../services/studentService');
const { recordAudit } = require('../lib/authDb');

// Derive department / year-or-semester / section from a student_id like:
//   "BBA-A1-3SEM-030" -> { BBA, A1, 3 Sem }
//   "BCOM-1SEM-005"   -> { BCOM, -, 1 Sem }
//   "BCA-A1-5SEM-042" -> { BCA, A1, 5 Sem }
function classFromStudentId(studentId) {
  if (!studentId) return { department: null, yearOrSemester: null, section: null };
  const parts = String(studentId).trim().split('-');
  // Pattern 1: DEPT-A#-NSEM-NNN  (section middle segment like A1/A2/A3)
  // Pattern 2: DEPT-NSEM-NNN     (no section, e.g. BCOM/MBA/MCA)
  const semIndex = parts.findIndex((p) => /^\d+SEM$/i.test(p));
  if (semIndex <= 0 || semIndex >= parts.length - 1) {
    return { department: parts[0] || null, yearOrSemester: null, section: null };
  }
  const sectionParts = parts.slice(1, semIndex);
  const department = parts[0] || null;
  const yearOrSemester = String(parts[semIndex]).replace(/^(\d+)SEM$/i, '$1 Sem');
  const section =
    sectionParts.length > 0 && sectionParts[0].length <= 4
      ? sectionParts[0]
      : null;
  return { department, yearOrSemester, section };
}

class StudentController {
  /**
   * GET /api/v1/students
   */
  async list(req, res, next) {
    try {
      const { active_only, limit, offset } = req.query;

      const students = await studentService.findAll({
        activeOnly: active_only === 'true',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
      });

      res.json({
        data: students,
        meta: {
          count: students.length,
          limit: parseInt(limit) || 100,
          offset: parseInt(offset) || 0,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/students/:id
   */
  async get(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid student ID',
        });
      }

      const student = await studentService.findById(parseInt(id));

      if (!student) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Student with ID ${id} not found`,
        });
      }

      res.json({ data: student });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/students/profile
   * Authenticated — the caller's own student record. Identity always comes
   * from the session (req.user.studentId), never from the client.
   */
  async profile(req, res, next) {
    try {
      const studentId = req.user?.studentId;
      if (!studentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }

      const student = await studentService.findById(studentId);

      if (!student) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Student record not found.',
        });
      }

      // If class fields are missing on the row (common when the whitelist row
      // was created with only name/email), derive them from the student_id
      // (e.g. "BCA-A1-3SEM-030" -> BCA / A1 / 3 Sem, "BCOM-1SEM-005" -> BCOM / - / 1 Sem).
      const parsedClass = classFromStudentId(student.student_id);
      const department = student.department || parsedClass.department;
      const yearOrSemester = student.year_or_semester || parsedClass.yearOrSemester;
      const section = student.section || parsedClass.section;

      res.json({
        data: {
          id: String(student.id),
          studentId: student.student_id || null,
          name: student.name,
          email: student.email || student.official_email || student.current_login_email || null,
          enrollmentNumber: student.roll_number || student.enrollment_number || null,
          department,
          year: yearOrSemester,
          section,
          phone: student.mobile_number || null,
          avatar: student.profile_image_url || null,
          profileImageUrl: student.profile_image_url || null,
          role: student.role,
          isActive: !!student.is_active,
          votingEligible: !!student.voting_eligible,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/students/by-external-id/:externalId
   */
  async getByExternalId(req, res, next) {
    try {
      const { externalId } = req.params;

      if (!externalId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'External ID is required',
        });
      }

      const student = await studentService.findByExternalId(externalId);

      if (!student) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Student with external ID '${externalId}' not found`,
        });
      }

      res.json({ data: student });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/students
   */
  async create(req, res, next) {
    try {
      const { external_id, name, email } = req.body;

      // Validate required fields
      const errors = [];
      if (!external_id || typeof external_id !== 'string' || external_id.trim() === '') {
        errors.push('external_id is required and must be a non-empty string');
      }
      if (!name || typeof name !== 'string' || name.trim() === '') {
        errors.push('name is required and must be a non-empty string');
      }
      if (email && typeof email === 'string' && !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
        errors.push('email format is invalid');
      }

      if (errors.length > 0) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Invalid input data',
          details: errors,
        });
      }

      const student = await studentService.create({
        external_id: external_id.trim(),
        name: name.trim(),
        email: email ? email.trim() : null,
      });

      res.status(201).json({ data: student });
    } catch (err) {
      // Handle duplicate external_id
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Conflict',
          message: `A student with external_id '${req.body.external_id}' already exists`,
        });
      }
      next(err);
    }
  }

  /**
   * PATCH /api/v1/students/:id
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, email, voting_eligible, role, department, year_or_semester, section } = req.body;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid student ID',
        });
      }

      // Validate optional fields
      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'name must be a non-empty string if provided',
        });
      }

      if (email !== undefined && email !== null && typeof email === 'string' && !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'email format is invalid',
        });
      }

      if (voting_eligible !== undefined && typeof voting_eligible !== 'boolean') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'voting_eligible must be a boolean',
        });
      }

      const VALID_ROLES = ['STUDENT', 'CANDIDATE', 'CAD', 'ADMIN'];
      if (role !== undefined && !VALID_ROLES.includes(role)) {
        return res.status(400).json({
          error: 'Validation Error',
          message: `role must be one of: ${VALID_ROLES.join(', ')}`,
        });
      }

      if (
        department !== undefined &&
        (typeof department !== 'string' || department.trim() === '')
      ) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'department must be a non-empty string if provided',
        });
      }

      if (
        year_or_semester !== undefined &&
        (typeof year_or_semester !== 'string' || year_or_semester.trim() === '')
      ) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'year_or_semester must be a non-empty string if provided',
        });
      }

      if (
        section !== undefined &&
        section !== null &&
        (typeof section !== 'string' || section.trim() === '' || section.trim().length > 20)
      ) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'section must be a non-empty string up to 20 characters if provided',
        });
      }

      // Guard: an admin must never demote themselves (lockout protection)
      if (role !== undefined && role !== 'ADMIN' && req.user && req.user.studentId === parseInt(id)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'You cannot change your own role.',
        });
      }

      const student = await studentService.update(parseInt(id), {
        name: name ? name.trim() : null,
        email: email !== undefined ? (email ? email.trim() : null) : undefined,
        voting_eligible: voting_eligible !== undefined ? voting_eligible : undefined,
        role: role !== undefined ? role : undefined,
        department: department !== undefined ? department.trim() : undefined,
        year_or_semester: year_or_semester !== undefined ? year_or_semester.trim() : undefined,
        section: section !== undefined ? (section ? section.trim().toUpperCase() : null) : undefined,
      });

      if (!student) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Student with ID ${id} not found`,
        });
      }

      // Audit-log every eligibility/role change (never log secrets)
      if (voting_eligible !== undefined) {
        await recordAudit('STUDENT_VOTING_ELIGIBILITY_CHANGED', {
          studentId: parseInt(id),
          ip: req.ip || null,
          metadata: { voting_eligible, changedBy: req.user?.email || null },
        });
      }
      if (role !== undefined) {
        await recordAudit('STUDENT_ROLE_CHANGED', {
          studentId: parseInt(id),
          ip: req.ip || null,
          metadata: { newRole: role, changedBy: req.user?.email || null },
        });
      }
      if (department !== undefined || year_or_semester !== undefined || section !== undefined) {
        await recordAudit('STUDENT_SECTION_CHANGED', {
          studentId: parseInt(id),
          ip: req.ip || null,
          metadata: { department, year_or_semester, section, changedBy: req.user?.email || null },
        });
      }

      res.json({ data: student });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/students/:id/status
   */
  async updateStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { is_active } = req.body;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid student ID',
        });
      }

      if (typeof is_active !== 'boolean') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'is_active must be a boolean',
        });
      }

      const student = await studentService.updateStatus(parseInt(id), is_active);

      if (!student) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Student with ID ${id} not found`,
        });
      }

      res.json({ data: student });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/students/profile (self-service)
   * Update own profile (name, phone, avatar). Wired to Appwrite "Profile Images" bucket.
   */
  async updateProfile(req, res, next) {
    try {
      const studentId = req.user?.studentId;
      if (!studentId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required.',
          code: 'AUTH_REQUIRED',
        });
      }
      const { name, phone, avatar, profileImageUrl, profile_image_url } = req.body || {};
      const avatarUrl = profileImageUrl || profile_image_url || avatar || undefined;
      if (name !== undefined && typeof name === 'string' && name.trim() === '') {
        return res.status(400).json({ error: 'Validation Error', message: 'name cannot be empty' });
      }
      const updated = await studentService.updateOwnProfile(studentId, {
        name,
        phone,
        profile_image_url: avatarUrl,
      });
      if (!updated) {
        return res.status(404).json({ error: 'Not Found', message: 'Student record not found.' });
      }
      res.json({
        data: {
          id: String(updated.id),
          name: updated.name,
          email: updated.email || updated.official_email || updated.current_login_email || null,
          enrollmentNumber: updated.roll_number || updated.enrollment_number || null,
          department: updated.department || null,
          year: updated.year_or_semester || null,
          section: updated.section || null,
          phone: updated.mobile_number || null,
          avatar: updated.profile_image_url || null,
          profileImageUrl: updated.profile_image_url || null,
          role: updated.role,
          isActive: !!updated.is_active,
          votingEligible: !!updated.voting_eligible,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/students/bulk-voting-eligible
   * Set voting_eligible for all (or a filtered set of) students.
   */
  async bulkSetVotingEligible(req, res, next) {
    try {
      const { voting_eligible, role, is_active } = req.body;

      if (typeof voting_eligible !== 'boolean') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'voting_eligible must be a boolean',
        });
      }

      const db = require('../db');
      let query = 'UPDATE students SET voting_eligible = $1';
      const params = [voting_eligible];
      const conditions = [];

      if (role && typeof role === 'string') {
        conditions.push(`role = $${params.length + 1}`);
        params.push(role);
      }
      if (typeof is_active === 'boolean') {
        conditions.push(`is_active = $${params.length + 1}`);
        params.push(is_active);
      }
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      const result = await db.query(query, params);

      res.json({
        data: {
          updated: result.rowCount,
          voting_eligible,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new StudentController();
