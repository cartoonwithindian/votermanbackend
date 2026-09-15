/**
 * Candidate Application Service
 * Business logic for candidate application workflow
 */

const db = require('../db');
const candidateService = require('./candidateService');
const constituencyService = require('./constituencyService');
const electionService = require('./electionService');
const positionService = require('./positionService');

class CandidateApplicationService {
  /**
   * Create a new candidate application
   */
  async create(data, studentId) {
    const {
      fullName,
      enrollmentNumber,
      department,
      year,
      semester,
      section,
      positionId,
      nominationClub,
      contestingPosition,
      email,
      phone,
      profilePhotoUrl,
      bio,
      manifesto,
      age,
      dateOfBirth,
      gender,
      aadharNumber,
      category,
      electionId,
    } = data;

    // Check if enrollment number already has an application (not rejected)
    const existingApp = await db.query(
      `SELECT id FROM candidate_applications
       WHERE enrollment_number = $1 AND status != 'rejected'`,
      [enrollmentNumber]
    );

    if (existingApp.rows.length > 0) {
      const error = new Error('An application already exists for this enrollment number.');
      error.code = 'DUPLICATE_ENROLLMENT';
      error.status = 409;
      throw error;
    }

    const appCategory = (category || 'CR').toUpperCase();
    if (appCategory !== 'CR' && appCategory !== 'CLASS_REPRESENTATIVE') {
      const error = new Error('Invalid category. Only Class Representative applications are accepted.');
      error.code = 'INVALID_CATEGORY';
      error.status = 400;
      throw error;
    }

    // Verify position exists ONLY when one was supplied (position_id is now
    // optional; nomination_club + contesting_position carry the real data).
    if (positionId) {
      const positionCheck = await db.query(
        'SELECT id, name FROM positions WHERE id = $1',
        [positionId]
      );

      if (positionCheck.rows.length === 0) {
        const error = new Error('Invalid position selected.');
        error.code = 'INVALID_POSITION';
        error.status = 400;
        throw error;
      }
    }

    // Verify the election exists when supplied (optional at apply time; the
    // admin assigns the definitive election/constituency at approval).
    if (electionId) {
      const electionCheck = await db.query(
        'SELECT id FROM elections WHERE id = $1',
        [parseInt(electionId)]
      );
      if (electionCheck.rows.length === 0) {
        const error = new Error('Invalid election selected.');
        error.code = 'INVALID_ELECTION';
        error.status = 400;
        throw error;
      }
    }

    // Create the application with status = under_review
    const result = await db.query(
      `INSERT INTO candidate_applications (
        student_id, full_name, enrollment_number, department, year, semester, section,
        position_id, nomination_club, contesting_position, email, phone, profile_photo_url, bio, manifesto,
        age, date_of_birth, gender, aadhar_number, category, election_id,
        status, submitted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'under_review', NOW())
      RETURNING *`,
      [
        studentId, fullName, enrollmentNumber, department, year, semester || null, section || null,
        positionId || null, nominationClub || null, contestingPosition || null,
        email, phone, profilePhotoUrl || null, bio || null, manifesto || null,
        age || null, dateOfBirth || null, gender || null, aadharNumber || null,
        appCategory, electionId ? parseInt(electionId) : null,
      ]
    );

    return this.formatApplication(result.rows[0]);
  }

  /**
   * Get application by student ID
   */
  async getByStudentId(studentId) {
    const result = await db.query(
      `SELECT ca.*, p.name as position_name
       FROM candidate_applications ca
       LEFT JOIN positions p ON ca.position_id = p.id
       WHERE ca.student_id = $1
       ORDER BY ca.created_at DESC
       LIMIT 1`,
      [studentId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.formatApplication(result.rows[0]);
  }

  /**
   * Get application by ID
   */
  async getById(id) {
    const result = await db.query(
      `SELECT ca.*, p.name as position_name,
              r.name as reviewer_name
       FROM candidate_applications ca
       LEFT JOIN positions p ON ca.position_id = p.id
       LEFT JOIN students r ON ca.reviewed_by = r.id
       WHERE ca.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.formatApplication(result.rows[0]);
  }

  /**
   * List all applications for admin (with filtering)
   */
  async listForAdmin(filters = {}) {
    const { status, department, positionId, search, limit = 100, offset = 0 } = filters;

    let query = `
      SELECT ca.*, p.name as position_name
      FROM candidate_applications ca
      LEFT JOIN positions p ON ca.position_id = p.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      query += ` AND ca.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (department && department !== 'all') {
      query += ` AND ca.department = $${paramIndex}`;
      params.push(department);
      paramIndex++;
    }

    if (positionId && positionId !== 'all') {
      query += ` AND ca.position_id = $${paramIndex}`;
      params.push(parseInt(positionId));
      paramIndex++;
    }

    if (search) {
      query += ` AND (
        ca.full_name ILIKE $${paramIndex} OR
        ca.enrollment_number ILIKE $${paramIndex} OR
        ca.email ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY ca.submitted_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);
    return result.rows.map(row => this.formatApplication(row));
  }

  /**
   * Count applications for admin
   */
  async countForAdmin(filters = {}) {
    const { status, department, positionId, search } = filters;

    let query = `SELECT COUNT(*) as total FROM candidate_applications ca WHERE 1=1`;
    const params = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      query += ` AND ca.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (department && department !== 'all') {
      query += ` AND ca.department = $${paramIndex}`;
      params.push(department);
      paramIndex++;
    }

    if (positionId && positionId !== 'all') {
      query += ` AND ca.position_id = $${paramIndex}`;
      params.push(parseInt(positionId));
      paramIndex++;
    }

    if (search) {
      query += ` AND (
        ca.full_name ILIKE $${paramIndex} OR
        ca.enrollment_number ILIKE $${paramIndex} OR
        ca.email ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
    }

    const result = await db.query(query, params);
    return parseInt(result.rows[0].total);
  }

  /**
   * Approve application
   *
   * For Class Representative (CR) applications the admin must resolve the
   * election + constituency seat the applicant will contest. The server
   * enforces that the assigned constituency's department/year/section matches
   * the application's identity exactly, then sets position_id and creates the
   * ballot row for the constituency's CR position.
   *
   * context: { electionId?, constituencyId? }
   */
  async approve(id, adminId, context = {}) {
    const app = await this.getById(id);

    if (!app) {
      const error = new Error('Application not found.');
      error.code = 'NOT_FOUND';
      error.status = 404;
      throw error;
    }

    if (app.status !== 'under_review') {
      const error = new Error('Application cannot be approved from current status.');
      error.code = 'INVALID_STATUS_TRANSITION';
      error.status = 400;
      throw error;
    }

    const isCR = app.category === 'CR' || app.category === 'CLASS_REPRESENTATIVE';

    // Resolve the CR election + constituency + position up-front so the
    // update can set all of the ballot data authoritatively.
    let crElectionId = null;
    if (isCR) {
      let constituencyId = context.constituencyId ? parseInt(context.constituencyId) : null;
      let electionId = context.electionId ? parseInt(context.electionId) : null;

      if (constituencyId) {
        const constituency = await constituencyService.findById(constituencyId);
        if (!constituency) {
          const error = new Error('Constituency not found.');
          error.code = 'CONSTITUENCY_NOT_FOUND';
          error.status = 404;
          throw error;
        }

        const match = (a, b) => (a ?? '').toString().trim().toLowerCase() === (b ?? '').toString().trim().toLowerCase();
        if (!match(constituency.department, app.department) ||
            !match(constituency.year, app.year) ||
            !match(constituency.section, app.section)) {
          const error = new Error(
            'Constituency does not match the applicant\u2019s department/year/section.'
          );
          error.code = 'CONSTITUENCY_MISMATCH';
          error.status = 400;
          throw error;
        }

        electionId = electionId || constituency.election_id;
        if (electionId !== constituency.election_id) {
          const error = new Error('Election does not match the constituency\u2019s election.');
          error.code = 'CONSTITUENCY_MISMATCH';
          error.status = 400;
          throw error;
        }
      } else {
        // No explicit constituency: resolve from the applicant identity against
        // the supplied (or application's) election.
        electionId = electionId || app.electionId;
        if (!electionId) {
          // Auto-resolve: find the latest non-draft election with an active
          // constituency matching this applicant's identity.
          const elections = await electionService.findAll({ excludeDraft: true, limit: 10 });
          for (const el of elections) {
            const constituency = await constituencyService.findMatching({
              electionId: el.id,
              department: app.department,
              year: app.year,
              section: app.section,
              activeOnly: true,
            });
            if (constituency) {
              electionId = el.id;
              constituencyId = constituency.id;
              break;
            }
          }
          if (!electionId) {
            const error = new Error(
              'For Class Representative applications an election is required. No active election with a matching constituency was found.'
            );
            error.code = 'ELECTION_REQUIRED';
            error.status = 400;
            throw error;
          }
        }
        if (!constituencyId) {
          const constituency = await constituencyService.findMatching({
            electionId,
            department: app.department,
            year: app.year,
            section: app.section,
            activeOnly: true,
          });
          if (!constituency) {
            const error = new Error(
              'No matching Class Representative constituency exists for this applicant in the selected election.'
            );
            error.code = 'CONSTITUENCY_NOT_FOUND';
            error.status = 404;
            throw error;
          }
          constituencyId = constituency.id;
        }
      }

      // CR position for the constituency (auto-created with the constituency).
      const positions = await positionService.findByConstituencyId(constituencyId);
      const crPosition = positions.find(p => p.constituency_id === constituencyId);
      if (!crPosition) {
        const error = new Error('No Class Representative position exists for this constituency.');
        error.code = 'CONSTITUENCY_POSITION_MISSING';
        error.status = 409;
        throw error;
      }

      crElectionId = electionId;
      context._constituencyId = constituencyId;
      context._positionId = crPosition.id;
    }

    const result = await db.query(
      `UPDATE candidate_applications
       SET status = 'approved',
           reviewed_by = $1,
           reviewed_at = NOW(),
           updated_at = NOW(),
           election_id = COALESCE($3, election_id),
           position_id = COALESCE($4, position_id)
       WHERE id = $2 AND status = 'under_review'
       RETURNING *`,
      [
        adminId, id,
        isCR ? crElectionId : null,
        isCR ? context._positionId : null,
      ]
    );

    // Approval is what EARNS the applicant the CANDIDATE role. The login-time
    // role picker no longer grants it — this is the only promotion path.
    const appId = result.rows[0].student_id;
    if (appId) {
      await db.query(
        `UPDATE students SET role = 'CANDIDATE', updated_at = NOW()
         WHERE id = $1 AND role IN ('STUDENT', 'CANDIDATE')`,
        [appId]
      );
    }

    // Also create a ballot row in `candidates` so the approved applicant
    // actually appears on the ballot. Only possible when a position_id was
    // supplied (position_id is optional on the application). If no position,
    // the candidate cannot be on a ballot; skip silently.
    if (result.rows[0].position_id) {
      try {
        await candidateService.create({
          position_id: result.rows[0].position_id,
          name: result.rows[0].full_name,
          description: result.rows[0].bio || result.rows[0].manifesto || null,
          image_url: result.rows[0].profile_photo_url || null,
        });
      } catch (err) {
        // Duplicate name within the same position OR position no longer valid.
        // Do not fail the approval: the application is still valid, the ballot
        // row is best-effort. Log and continue.
        if (err.code !== '23505' && err.code !== '23503') {
          throw err;
        }
        console.warn(
          'approve: could not create candidates ballot row',
          { applicationId: id, positionId: result.rows[0].position_id, code: err.code }
        );
      }
    }

    return this.formatApplication(result.rows[0]);
  }

  /**
   * Reject application
   */
  async reject(id, reason, adminId) {
    const app = await this.getById(id);

    if (!app) {
      const error = new Error('Application not found.');
      error.code = 'NOT_FOUND';
      error.status = 404;
      throw error;
    }

    if (app.status !== 'under_review') {
      const error = new Error('Application cannot be rejected from current status.');
      error.code = 'INVALID_STATUS_TRANSITION';
      error.status = 400;
      throw error;
    }

    const result = await db.query(
      `UPDATE candidate_applications
       SET status = 'rejected',
           rejection_reason = $1,
           reviewed_by = $2,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [reason, adminId, id]
    );

    // If this applicant was promoted by a previous approval that was later
    // reversed, drop them back to STUDENT (never touch ADMIN/CAD accounts).
    const appId = result.rows[0].student_id;
    if (appId) {
      await db.query(
        `UPDATE students SET role = 'STUDENT', updated_at = NOW()
         WHERE id = $1 AND role = 'CANDIDATE'`,
        [appId]
      );
    }

    // Remove the ballot row this applicant may have earned when they were
    // approved, so a reversed approval does not leave them contesting on the
    // ballot. Scoped by position (required) and name (the person).
    if (result.rows[0].position_id && result.rows[0].full_name) {
      await db.query(
        `DELETE FROM candidates
         WHERE position_id = $1 AND name = $2`,
        [result.rows[0].position_id, result.rows[0].full_name]
      );
    }

    return this.formatApplication(result.rows[0]);
  }

  /**
   * Request changes
   */
  async requestChanges(id, reason, adminId) {
    const app = await this.getById(id);

    if (!app) {
      const error = new Error('Application not found.');
      error.code = 'NOT_FOUND';
      error.status = 404;
      throw error;
    }

    if (app.status !== 'under_review') {
      const error = new Error('Application cannot request changes from current status.');
      error.code = 'INVALID_STATUS_TRANSITION';
      error.status = 400;
      throw error;
    }

    const result = await db.query(
      `UPDATE candidate_applications
       SET status = 'changes_requested',
           changes_requested_reason = $1,
           reviewed_by = $2,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [reason, adminId, id]
    );

    return this.formatApplication(result.rows[0]);
  }

  /**
   * Resubmit application (candidate updates after changes_requested)
   */
  async resubmit(id, data, studentId) {
    const app = await this.getById(id);

    if (!app) {
      const error = new Error('Application not found.');
      error.code = 'NOT_FOUND';
      error.status = 404;
      throw error;
    }

    // Only changes_requested applications can be resubmitted
    if (app.status !== 'changes_requested') {
      const error = new Error('Application can only be resubmitted when changes are requested.');
      error.code = 'INVALID_STATUS';
      error.status = 400;
      throw error;
    }

    // Verify ownership
    if (app.studentId !== studentId) {
      const error = new Error('You can only update your own application.');
      error.code = 'FORBIDDEN';
      error.status = 403;
      throw error;
    }

    // Update only allowed fields (verified fields are NOT allowed to change)
    const { bio, manifesto, profilePhotoUrl, email, phone } = data;

    const result = await db.query(
      `UPDATE candidate_applications
       SET status = 'under_review',
           bio = COALESCE($1, bio),
           manifesto = COALESCE($2, manifesto),
           profile_photo_url = COALESCE($3, profile_photo_url),
           email = COALESCE($4, email),
           phone = COALESCE($5, phone),
           changes_requested_reason = NULL,
           reviewed_by = NULL,
           reviewed_at = NULL,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [bio, manifesto, profilePhotoUrl, email, phone, id]
    );

    return this.formatApplication(result.rows[0]);
  }

  /**
   * Update profile after approval (only editable fields)
   */
  async updateProfile(id, data, studentId) {
    const app = await this.getById(id);

    if (!app) {
      const error = new Error('Application not found.');
      error.code = 'NOT_FOUND';
      error.status = 404;
      throw error;
    }

    // Verify ownership
    if (app.studentId !== studentId) {
      const error = new Error('You can only update your own application.');
      error.code = 'FORBIDDEN';
      error.status = 403;
      throw error;
    }

    // If not approved, they shouldn't be accessing profile update
    if (app.status !== 'approved') {
      const error = new Error('Profile can only be updated after approval.');
      error.code = 'NOT_APPROVED';
      error.status = 403;
      throw error;
    }

    // Only allow editable fields
    const { bio, manifesto, profilePhotoUrl } = data;

    const result = await db.query(
      `UPDATE candidate_applications
       SET bio = COALESCE($1, bio),
           manifesto = COALESCE($2, manifesto),
           profile_photo_url = COALESCE($3, profile_photo_url),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [bio, manifesto, profilePhotoUrl, id]
    );

    return this.formatApplication(result.rows[0]);
  }

  /**
   * Get access info for candidate portal
   */
  async getAccessInfo(studentId) {
    const app = await this.getByStudentId(studentId);

    if (!app) {
      return {
        hasApplication: false,
        status: null,
        isApproved: false,
        canAccessCandidatePortal: false,
      };
    }

    return {
      hasApplication: true,
      status: app.status,
      isApproved: app.status === 'approved',
      canAccessCandidatePortal: app.status === 'approved',
    };
  }

  /**
   * Format application for API response
   */
  formatApplication(row) {
    if (!row) return null;

    return {
      id: row.id,
      studentId: row.student_id,
      fullName: row.full_name,
      enrollmentNumber: row.enrollment_number,
      department: row.department,
      year: row.year,
      semester: row.semester,
      section: row.section,
      positionId: row.position_id,
      positionName: row.position_name,
      nominationClub: row.nomination_club || null,
      contestingPosition: row.contesting_position || null,
      // Compat: UI components read `position`; prefer the new text field
      position: row.contesting_position || row.position_name || null,
      email: row.email,
      phone: row.phone,
      profilePhotoUrl: row.profile_photo_url,
      bio: row.bio,
      manifesto: row.manifesto,
      age: row.age,
      dateOfBirth: row.date_of_birth,
      gender: row.gender,
      aadharNumber: row.aadhar_number,
      category: row.category || 'CR',
      electionId: row.election_id || null,
      status: row.status,
      rejectionReason: row.rejection_reason,
      changesRequestedReason: row.changes_requested_reason,
      reviewedBy: row.reviewed_by,
      reviewerName: row.reviewer_name,
      reviewedAt: row.reviewed_at,
      submittedAt: row.submitted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new CandidateApplicationService();
