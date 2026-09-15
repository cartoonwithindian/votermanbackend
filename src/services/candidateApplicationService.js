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
    // If no matching election/constituency exists, still approve the
    // application — just skip ballot placement. The admin can assign
    // them to a ballot later.
    let crElectionId = null;
    let crResolved = false;
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
              section: app.section || '',
              activeOnly: true,
            });
            if (constituency) {
              electionId = el.id;
              constituencyId = constituency.id;
              break;
            }
          }
        }
        if (electionId && !constituencyId) {
          const constituency = await constituencyService.findMatching({
            electionId,
            department: app.department,
            year: app.year,
            section: app.section || '',
            activeOnly: true,
          });
          if (constituency) {
            constituencyId = constituency.id;
          }
        }
      }

      // Only place on ballot if we successfully resolved everything.
      if (constituencyId && electionId) {
        const positions = await positionService.findByConstituencyId(constituencyId);

        // Route the approved applicant onto the seat matching their gender
        // (Boy CR -> Male seat, Girl CR -> Female seat). Fall back to any CR
        // seat in the constituency for legacy/unisex seats or applications
        // with no / 'Other' gender.
        const gender = String(app.gender || '').trim();
        const genderedSeat = (gender === 'Male' || gender === 'Female')
          ? positions.find(p => p.gender === gender)
          : null;
        const crPosition = genderedSeat || positions.find(p => p.constituency_id === constituencyId);
        if (!crPosition) {
          const error = new Error('No Class Representative position exists for this constituency.');
          error.code = 'CONSTITUENCY_POSITION_MISSING';
          error.status = 409;
          throw error;
        }

        crElectionId = electionId;
        context._constituencyId = constituencyId;
        context._positionId = crPosition.id;
        crResolved = true;
      } else {
        console.warn(
          'approve: CR application approved without ballot placement — no matching election/constituency found',
          { applicationId: id, department: app.department, year: app.year, section: app.section }
        );
      }
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

    if (result.rows.length === 0) {
      const error = new Error('Application is not under review or no longer exists.');
      error.code = 'INVALID_STATUS';
      error.status = 400;
      throw error;
    }

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
   * Place an already-approved CR application onto its ballot.
   *
   * Approvals made before a matching constituency existed (or while the
   * election was still DRAFT) carry no election/position link and therefore
   * no ballot row. This resolves the seat with the same rules as approve():
   * an explicit constituencyId wins (identity must match exactly), otherwise
   * auto-resolve the latest non-draft election with a matching active
   * constituency — then links election/position and creates the ballot row.
   *
   * context: { electionId?, constituencyId? }
   */
  async assignBallot(id, context = {}) {
    const app = await this.getById(id);

    if (!app) {
      const error = new Error('Application not found.');
      error.code = 'NOT_FOUND';
      error.status = 404;
      throw error;
    }

    if (app.status !== 'approved') {
      const error = new Error('Only approved applications can be placed on a ballot.');
      error.code = 'INVALID_STATUS_TRANSITION';
      error.status = 400;
      throw error;
    }

    const isCR = app.category === 'CR' || app.category === 'CLASS_REPRESENTATIVE';
    if (!isCR) {
      const error = new Error('Only Class Representative applications can be placed on a CR ballot.');
      error.code = 'INVALID_CATEGORY';
      error.status = 400;
      throw error;
    }

    const match = (a, b) => (a ?? '').toString().trim().toLowerCase() === (b ?? '').toString().trim().toLowerCase();

    let constituencyId = context.constituencyId ? parseInt(context.constituencyId) : null;
    let electionId = context.electionId ? parseInt(context.electionId) : (app.electionId || null);

    if (constituencyId) {
      const constituency = await constituencyService.findById(constituencyId);
      if (!constituency) {
        const error = new Error('Constituency not found.');
        error.code = 'CONSTITUENCY_NOT_FOUND';
        error.status = 404;
        throw error;
      }
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
      if (!electionId) {
        const elections = await electionService.findAll({ excludeDraft: true, limit: 10 });
        for (const el of elections) {
          const constituency = await constituencyService.findMatching({
            electionId: el.id,
            department: app.department,
            year: app.year,
            section: app.section || '',
            activeOnly: true,
          });
          if (constituency) {
            electionId = el.id;
            constituencyId = constituency.id;
            break;
          }
        }
      }
      if (electionId && !constituencyId) {
        const constituency = await constituencyService.findMatching({
          electionId,
          department: app.department,
          year: app.year,
          section: app.section || '',
          activeOnly: true,
        });
        if (constituency) {
          constituencyId = constituency.id;
        }
      }
    }

    if (!constituencyId || !electionId) {
      const error = new Error('No matching election/constituency found for this applicant.');
      error.code = 'CONSTITUENCY_NOT_FOUND';
      error.status = 409;
      throw error;
    }

    const positions = await positionService.findByConstituencyId(constituencyId);
    const gender = String(app.gender || '').trim();
    const genderedSeat = (gender === 'Male' || gender === 'Female')
      ? positions.find(p => p.gender === gender)
      : null;
    const crPosition = genderedSeat || positions.find(p => p.constituency_id === constituencyId);
    if (!crPosition) {
      const error = new Error('No Class Representative position exists for this constituency.');
      error.code = 'CONSTITUENCY_POSITION_MISSING';
      error.status = 409;
      throw error;
    }

    const result = await db.query(
      `UPDATE candidate_applications
       SET election_id = $2,
           position_id = $3,
           updated_at = NOW()
       WHERE id = $1 AND status = 'approved'
       RETURNING *`,
      [id, electionId, crPosition.id]
    );

    if (result.rows.length === 0) {
      const error = new Error('Application is no longer approved.');
      error.code = 'INVALID_STATUS';
      error.status = 409;
      throw error;
    }

    // Create the ballot row best-effort (a re-place hits the unique
    // (position_id, name) constraint and is safely skipped).
    try {
      await candidateService.create({
        position_id: result.rows[0].position_id,
        name: result.rows[0].full_name,
        description: result.rows[0].bio || result.rows[0].manifesto || null,
        image_url: result.rows[0].profile_photo_url || null,
      });
    } catch (err) {
      if (err.code !== '23505' && err.code !== '23503') {
        throw err;
      }
      console.warn(
        'assignBallot: could not create candidates ballot row',
        { applicationId: id, positionId: result.rows[0].position_id, code: err.code }
      );
    }

    return this.formatApplication(result.rows[0]);
  }

  /**
   * Place every approved-but-unplaced CR application matching this election's
   * constituencies onto its ballot. Called automatically when an election
   * opens so approval always means ballot-ready — no manual step.
   * Best-effort per application: failures are skipped with a warn log and
   * reported in `skipped`, never thrown.
   */
  async placeUnplacedForElection(electionId) {
    const pending = await db.query(
      `SELECT id FROM candidate_applications
       WHERE status = 'approved'
         AND (category = 'CR' OR category = 'CLASS_REPRESENTATIVE')
         AND (election_id IS NULL OR position_id IS NULL)`
    );

    const placed = [];
    const skipped = [];
    for (const row of pending.rows) {
      try {
        const app = await this.getById(row.id);
        if (!app) {
          skipped.push(row.id);
          continue;
        }
        const constituency = await constituencyService.findMatching({
          electionId,
          department: app.department,
          year: app.year,
          section: app.section || '',
          activeOnly: true,
        });
        if (!constituency) {
          skipped.push(row.id);
          continue;
        }
        await this.assignBallot(row.id, { electionId, constituencyId: constituency.id });
        placed.push(row.id);
      } catch (err) {
        console.warn(
          'placeUnplacedForElection: skipped application',
          { applicationId: row.id, code: err.code || err.message }
        );
        skipped.push(row.id);
      }
    }
    return { placed, skipped };
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
      category: row.category || 'CLUB',
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

  /**
   * Find all approved candidates for admin position management.
   * Used by admin Positions page to show candidates with class/section details.
   *
   * @param {Object} options
   * @param {number} options.positionId - Filter by position ID
   * @param {string} options.department - Filter by department
   * @param {string} options.section - Filter by section
   * @param {string} options.year - Filter by year
   */
  async findApprovedForAdmin(options = {}) {
    const { positionId, department, section, year } = options;

    let query = `
      SELECT
        ca.id,
        ca.student_id,
        ca.full_name,
        ca.gender,
        ca.department,
        ca.year,
        ca.section,
        ca.position_id,
        ca.category,
        p.name AS position_name,
        ca.status
      FROM candidate_applications ca
      LEFT JOIN positions p ON ca.position_id = p.id
      WHERE ca.status = 'approved'
    `;

    const params = [];
    let paramIndex = 1;

    if (positionId) {
      query += ` AND ca.position_id = $${paramIndex}`;
      params.push(positionId);
      paramIndex++;
    }

    if (department && department !== 'all') {
      query += ` AND ca.department = $${paramIndex}`;
      params.push(department);
      paramIndex++;
    }

    if (section && section !== 'all') {
      query += ` AND ca.section = $${paramIndex}`;
      params.push(section);
      paramIndex++;
    }

    if (year && year !== 'all') {
      query += ` AND ca.year = $${paramIndex}`;
      params.push(year);
      paramIndex++;
    }

    query += ' ORDER BY ca.department, ca.year, ca.section, ca.full_name';

    const result = await db.query(query, params);
    return result.rows;
  }
}

module.exports = new CandidateApplicationService();
