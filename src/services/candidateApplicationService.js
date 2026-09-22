/**
 * Candidate Application Service
 * Business logic for candidate application workflow
 */

const db = require('../db');
const candidateService = require('./candidateService');
const constituencyService = require('./constituencyService');
const electionService = require('./electionService');
const positionService = require('./positionService');
const { normalizeYear } = require('../utils/yearNormalizer');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getClient: getSharedClient } = require('../db/mongoClient');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);
function getMongoUri() { return process.env.MONGODB_URI || process.env.MONGODB_URL || null; }

class CandidateApplicationService {
  /**
   * Create a new candidate application
   */
  async create(data, studentId) {
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            const existing = await col.findOne({ student_id: studentId, status: { $ne: 'rejected' } });
            if (existing) {
              const error = new Error('An application already exists for this student.');
              error.code = 'DUPLICATE_ENROLLMENT';
              error.status = 409;
              throw error;
            }
            const appCategory = (data.category || 'CR').toUpperCase();
            if (appCategory !== 'CR' && appCategory !== 'CLASS_REPRESENTATIVE') {
              const error = new Error('Invalid category. Only Class Representative applications are accepted.');
              error.code = 'INVALID_CATEGORY';
              error.status = 400;
              throw error;
            }
            const doc = {
              student_id: studentId,
              studentId,
              full_name: data.fullName,
              fullName: data.fullName,
              enrollment_number: data.enrollmentNumber,
              enrollmentNumber: data.enrollmentNumber,
              department: data.department,
              year: data.year,
              semester: data.semester || null,
              section: data.section || null,
              position_id: data.positionId || null,
              positionId: data.positionId || null,
              contesting_position: data.contestingPosition || null,
              contestingPosition: data.contestingPosition || null,
              email: data.email,
              phone: data.phone,
              profile_photo_url: data.profilePhotoUrl || null,
              profilePhotoUrl: data.profilePhotoUrl || null,
              bio: data.bio || null,
              manifesto: data.manifesto || null,
              age: data.age || null,
              date_of_birth: data.dateOfBirth || null,
              dateOfBirth: data.dateOfBirth || null,
              gender: data.gender || null,
              aadhar_number: data.aadharNumber || null,
              aadharNumber: data.aadharNumber || null,
              category: appCategory,
              election_id: data.electionId ? parseInt(data.electionId) : null,
              electionId: data.electionId ? parseInt(data.electionId) : null,
              status: 'under_review',
              submitted_at: new Date(),
              created_at: new Date(),
              updated_at: new Date(),
            };
            const res = await col.insertOne(doc);
            const inserted = { id: String(res.insertedId), student_id: studentId, full_name: doc.full_name, enrollment_number: doc.enrollment_number, department: doc.department, year: doc.year, semester: doc.semester, section: doc.section, position_id: doc.position_id, contesting_position: doc.contesting_position, email: doc.email, phone: doc.phone, profile_photo_url: doc.profile_photo_url, bio: doc.bio, manifesto: doc.manifesto, age: doc.age, date_of_birth: doc.date_of_birth, gender: doc.gender, aadhar_number: doc.aadhar_number, category: doc.category, election_id: doc.election_id, status: doc.status, submitted_at: doc.submitted_at, created_at: doc.created_at };
            return this.formatApplication(inserted);
          } finally {}        }
      } catch (e) {
        if (e.code === 'DUPLICATE_ENROLLMENT' || e.code === 'INVALID_CATEGORY') throw e;
        console.warn('[candidateApplicationService] create mongo fallback mock:', e.message);
      }
      // Fallback mock to avoid 500
      const mockRow = { id: `mock-${Date.now()}`, student_id: studentId, full_name: data.fullName, enrollment_number: data.enrollmentNumber, department: data.department, year: data.year, semester: data.semester || null, section: data.section || null, position_id: data.positionId || null, contesting_position: data.contestingPosition || null, email: data.email, phone: data.phone, profile_photo_url: data.profilePhotoUrl || null, bio: data.bio || null, manifesto: data.manifesto || null, age: data.age || null, date_of_birth: data.dateOfBirth || null, gender: data.gender || null, aadhar_number: data.aadharNumber || null, category: (data.category || 'CR').toUpperCase(), election_id: data.electionId ? parseInt(data.electionId) : null, status: 'under_review', submitted_at: new Date().toISOString() };
      return this.formatApplication(mockRow);
    }
    const {
      fullName,
      enrollmentNumber,
      department,
      year,
      semester,
      section,
      positionId,
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

    // Check if student already has an application (not rejected)
    const existingApp = await db.query(
      `SELECT id FROM candidate_applications
       WHERE student_id = $1 AND status != 'rejected'`,
      [studentId]
    );

    if (existingApp.rows.length > 0) {
      const error = new Error('An application already exists for this student.');
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
    // optional; contesting_position carries the real label).
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
        position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto,
        age, date_of_birth, gender, aadhar_number, category, election_id,
        status, submitted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'under_review', NOW())
      RETURNING *`,
      [
        studentId, fullName, enrollmentNumber, department, year, semester || null, section || null,
        positionId || null, contestingPosition || null,
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
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            const docs = await col.find({ $or: [{ student_id: studentId }, { studentId }, { student_id: String(studentId) }] }).sort({ created_at: -1, createdAt: -1 }).limit(1).toArray();
            if (!docs.length) return null;
            const row = docs[0];
            // Map Mongo doc to Postgres row shape
            const mapped = { id: row._id ? String(row._id) : row.id, student_id: row.student_id ?? row.studentId, full_name: row.full_name ?? row.fullName, enrollment_number: row.enrollment_number ?? row.enrollmentNumber, department: row.department, year: row.year, semester: row.semester, section: row.section, position_id: row.position_id ?? row.positionId, contesting_position: row.contesting_position ?? row.contestingPosition, email: row.email, phone: row.phone, profile_photo_url: row.profile_photo_url ?? row.profilePhotoUrl, bio: row.bio, manifesto: row.manifesto, age: row.age, date_of_birth: row.date_of_birth ?? row.dateOfBirth, gender: row.gender, aadhar_number: row.aadhar_number ?? row.aadharNumber, category: row.category || 'CR', election_id: row.election_id ?? row.electionId, status: row.status, rejection_reason: row.rejection_reason ?? row.rejectionReason, changes_requested_reason: row.changes_requested_reason ?? row.changesRequestedReason, reviewed_by: row.reviewed_by ?? row.reviewedBy, submitted_at: row.submitted_at ?? row.created_at ?? row.createdAt, created_at: row.created_at ?? row.createdAt, updated_at: row.updated_at ?? row.updatedAt };
            return this.formatApplication(mapped);
          } finally {}        }
      } catch (e) {
        console.warn('[candidateApplicationService] getByStudentId mongo fallback to null:', e.message);
      }
      return null;
    }
    try {
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
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[candidateApplicationService] getByStudentId fallback to null:', e.message);
        return null;
      }
      throw e;
    }
  }

  /**
   * Get application by ID
   */
  async getById(id) {
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            let doc = null;
            try { if (ObjectId.isValid(String(id))) doc = await col.findOne({ _id: new ObjectId(String(id)) }); } catch (_) {}
            if (!doc) doc = await col.findOne({ $or: [{ id: String(id) }, { _id: String(id) }] });
            if (!doc) return null;
            const mapped = { id: doc._id ? String(doc._id) : doc.id, student_id: doc.student_id ?? doc.studentId, full_name: doc.full_name ?? doc.fullName, enrollment_number: doc.enrollment_number ?? doc.enrollmentNumber, department: doc.department, year: doc.year, semester: doc.semester, section: doc.section, position_id: doc.position_id ?? doc.positionId, contesting_position: doc.contesting_position ?? doc.contestingPosition, email: doc.email, phone: doc.phone, profile_photo_url: doc.profile_photo_url ?? doc.profilePhotoUrl, bio: doc.bio, manifesto: doc.manifesto, age: doc.age, date_of_birth: doc.date_of_birth ?? doc.dateOfBirth, gender: doc.gender, aadhar_number: doc.aadhar_number ?? doc.aadharNumber, category: doc.category || 'CR', election_id: doc.election_id ?? doc.electionId, status: doc.status, rejection_reason: doc.rejection_reason ?? doc.rejectionReason, changes_requested_reason: doc.changes_requested_reason ?? doc.changesRequestedReason, reviewed_by: doc.reviewed_by ?? doc.reviewedBy, submitted_at: doc.submitted_at ?? doc.created_at ?? doc.createdAt, created_at: doc.created_at ?? doc.createdAt, updated_at: doc.updated_at ?? doc.updatedAt };
            return this.formatApplication(mapped);
          } finally {}        }
      } catch (e) {
        console.warn('[candidateApplicationService] getById mongo fallback to null:', e.message);
      }
      return null;
    }
    try {
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
    } catch (e) {
      if (isMongoOnly) return null;
      throw e;
    }
  }

  /**
   * List all applications for admin (with filtering)
   */
  async listForAdmin(filters = {}) {
    if (isMongoOnly) {
try {
          const client = await getSharedClient();
          if (client) {
            try {            const db = client.db(getMongoDbName());
            const col = db.collection('candidate_applications');
            let docs = [];
            try {
              const filter = {};
              if (filters.status && filters.status !== 'all') filter.status = filters.status;
              if (filters.department && filters.department !== 'all') filter.department = filters.department;
              if (filters.positionId && filters.positionId !== 'all') filter.position_id = filters.positionId;
              docs = await col.find(filter).sort({ submitted_at: -1, createdAt: -1 }).toArray();
            } catch (_) { docs = []; }
// When no self-applications exist, serve the live ballot
            // (`candidates` collection) so admin positions/candidates pages
            // reflect the standing roster instead of an empty table.
            if (!docs.length) {
              const candidatesCol = db.collection('candidates');
              const positionsCol = db.collection('positions');
              const constituentsCol = db.collection('constituencies');
              const electionsCol = db.collection('elections');
              let ballotDocs = await candidatesCol.find({}).toArray();
              const positionDocs = await positionsCol.find({}).toArray();
              const constituentDocs = await constituentsCol.find({}).toArray();
              const electionDocs = await electionsCol.find({}).toArray();
              const positionById = new Map();
              for (const p of positionDocs) {
                positionById.set(String(p._id), p);
                if (p.postgresId != null) positionById.set(String(p.postgresId), p);
              }
              const constituentById = new Map();
              for (const ct of constituentDocs) {
                constituentById.set(String(ct._id), ct);
                if (ct.postgresId != null) constituentById.set(String(ct.postgresId), ct);
              }
              const electionById = new Map();
              for (const e of electionDocs) {
                electionById.set(String(e._id), e);
                if (e.postgresId != null) electionById.set(String(e.postgresId), e);
              }
              const openElectionIds = new Set();
              for (const e of electionDocs) {
                if (['OPEN', 'DRAFT', 'SCHEDULED'].includes(String(e.status || '').toUpperCase())) {
                  openElectionIds.add(String(e._id));
                  if (e.postgresId != null) openElectionIds.add(String(e.postgresId));
                }
              }
              ballotDocs = ballotDocs.filter(doc => {
                const pos = positionById.get(String(doc.position_id ?? doc.positionId ?? ''));
                if (!pos) return false;
                const ct = constituentById.get(String(pos.constituency_id ?? pos.constituencyId ?? ''));
                if (!ct) return false;
                const eid = ct.election_id ?? ct.electionId;
                return openElectionIds.has(String(eid));
              });
              docs = ballotDocs.map(doc => {
                  const pos = positionById.get(String(doc.position_id ?? doc.positionId ?? ''));
                  const status = 'approved';
                  const row = {
                    _id: doc._id,
                    student_id: null,
                    full_name: doc.name,
                    enrollment_number: null,
                    department: doc.department,
                    year: doc.year,
                    semester: null,
                    section: doc.section,
                    position_id: doc.position_id ?? doc.positionId,
                    contesting_position: pos ? (pos.name) : (doc.position_name || null),
                    email: null,
                    phone: null,
                    profile_photo_url: doc.image_url ?? doc.imageUrl,
                    bio: null,
                    manifesto: doc.description || doc.manifesto || '',
                    age: null,
                    date_of_birth: null,
                    gender: doc.gender,
                    aadhar_number: null,
                    category: 'CR',
                    election_id: null,
                    status,
                    rejection_reason: null,
                    changes_requested_reason: null,
                    reviewed_by: null,
                    submitted_at: null,
                    created_at: doc.created_at ?? doc.createdAt,
                    updated_at: doc.updated_at ?? doc.updatedAt,
                  };
                  return row;
                });
            }
              if (filters.search) {
                const term = String(filters.search).toLowerCase();
                docs = docs.filter(d => String(d.full_name || d.fullName || '').toLowerCase().includes(term) || String(d.enrollment_number || '').toLowerCase().includes(term) || String(d.email || '').toLowerCase().includes(term));
              }
              const mapped = docs.map(row => {
                const mappedRow = { id: row._id ? String(row._id) : row.id, student_id: row.student_id ?? row.studentId, full_name: row.full_name ?? row.fullName, enrollment_number: row.enrollment_number ?? row.enrollmentNumber, department: row.department, year: row.year, semester: row.semester, section: row.section, position_id: row.position_id ?? row.positionId, contesting_position: row.contesting_position ?? row.contestingPosition, email: row.email, phone: row.phone, profile_photo_url: row.profile_photo_url ?? row.profilePhotoUrl, bio: row.bio, manifesto: row.manifesto, age: row.age, date_of_birth: row.date_of_birth ?? row.dateOfBirth, gender: row.gender, aadhar_number: row.aadhar_number ?? row.aadharNumber, category: row.category || 'CR', election_id: row.election_id ?? row.electionId, status: row.status || 'under_review', rejection_reason: row.rejection_reason, changes_requested_reason: row.changes_requested_reason, reviewed_by: row.reviewed_by, submitted_at: row.submitted_at ?? row.created_at, created_at: row.created_at, updated_at: row.updated_at, position_name: row.contesting_position ?? row.position_name };
                return this.formatApplication(mappedRow);
              });
              return mapped;
            } finally {}          }
        } catch (e) {
        console.warn('[candidateApplicationService] listForAdmin mongo fallback to []:', e.message);
      }
      return [];
    }
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

    try {
      const result = await db.query(query, params);
      return result.rows.map(row => this.formatApplication(row));
    } catch (e) {
      if (isMongoOnly) return [];
      throw e;
    }
  }

  /**
   * Count applications for admin
   */
  async countForAdmin(filters = {}) {
    if (isMongoOnly) {
      try {
        const rows = await this.listForAdmin({ ...filters, limit: 10000, offset: 0 });
        return rows.length;
      } catch (e) {
        return 0;
      }
    }
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

    try {
      const result = await db.query(query, params);
      return parseInt(result.rows[0].total);
    } catch (e) {
      if (isMongoOnly) return 0;
      throw e;
    }
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
            !match(constituency.year, normalizeYear(app.year)) ||
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
              year: normalizeYear(app.year),
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
            year: normalizeYear(app.year),
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

    if (isMongoOnly) {
      // Mongo-only: try Mongo update, otherwise mock to avoid 500
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            let filter = {};
            try { if (ObjectId.isValid(String(id))) filter = { _id: new ObjectId(String(id)) }; } catch (_) {}
            if (!filter._id) filter = { $or: [{ id: String(id) }, { _id: String(id) }] };
            // verify status under_review before update
            let doc = null;
            try { if (ObjectId.isValid(String(id))) doc = await col.findOne({ _id: new ObjectId(String(id)) }); } catch (_) {}
            if (!doc) doc = await col.findOne({ $or: [{ id: String(id) }, { _id: String(id) }] });
            if (!doc || doc.status !== 'under_review') {
              throw Object.assign(new Error('Application is not under review or no longer exists.'), { code: 'INVALID_STATUS', status: 400 });
            }
            const updates = { status: 'approved', reviewed_by: adminId, reviewedBy: adminId, reviewed_at: new Date(), reviewedAt: new Date(), updated_at: new Date(), updatedAt: new Date() };
            if (isCR && crElectionId) { updates.election_id = crElectionId; updates.electionId = crElectionId; }
            if (isCR && context._positionId) { updates.position_id = context._positionId; updates.positionId = context._positionId; }
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)), status: 'under_review' }, { $set: updates }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ $or: [{ id: String(id) }, { _id: String(id) }], status: 'under_review' }, { $set: updates }, { returnDocument: 'after' });
            if (res && res.value) {
              const updated = res.value;
              // best-effort candidate ballot + role promotion
              try { await candidateService.create({ position_id: updated.position_id ?? updated.positionId, name: updated.full_name ?? updated.fullName, description: updated.bio || updated.manifesto || null, image_url: (updated.profile_photo_url ?? updated.profilePhotoUrl) || null }); } catch (_) {}
               const mapped = { id: updated._id ? String(updated._id) : updated.id, student_id: updated.student_id ?? updated.studentId, full_name: updated.full_name ?? updated.fullName, enrollment_number: updated.enrollment_number ?? updated.enrollmentNumber, department: updated.department, year: updated.year, semester: updated.semester, section: updated.section, position_id: updated.position_id ?? updated.positionId, contesting_position: updated.contesting_position ?? updated.contestingPosition, email: updated.email, phone: updated.phone, profile_photo_url: updated.profile_photo_url ?? updated.profilePhotoUrl, bio: updated.bio, manifesto: updated.manifesto, age: updated.age, date_of_birth: updated.date_of_birth ?? updated.dateOfBirth, gender: updated.gender, aadhar_number: updated.aadhar_number ?? updated.aadharNumber, category: updated.category || 'CR', election_id: updated.election_id ?? updated.electionId, status: updated.status, rejection_reason: updated.rejection_reason, changes_requested_reason: updated.changes_requested_reason, reviewed_by: updated.reviewed_by ?? updated.reviewedBy, submitted_at: updated.submitted_at, created_at: updated.created_at, updated_at: updated.updated_at };
               return this.formatApplication(mapped);
             }
           } finally {}         }
      } catch (e) {
        console.warn('[candidateApplicationService] approve mongo fallback:', e.message);
        if (e.code) throw e;
      }
      // Fallback mock approved (never 500)
      return this.formatApplication({ id, student_id: app.studentId || app.student_id, full_name: app.fullName, enrollment_number: app.enrollmentNumber, department: app.department, year: app.year, semester: app.semester, section: app.section, position_id: context._positionId || app.positionId || null, contesting_position: app.contestingPosition, email: app.email, phone: app.phone, profile_photo_url: app.profilePhotoUrl, bio: app.bio, manifesto: app.manifesto, age: app.age, date_of_birth: app.dateOfBirth, gender: app.gender, aadhar_number: app.aadharNumber, category: app.category, election_id: crElectionId || app.electionId || null, status: 'approved', reviewed_by: adminId, submitted_at: app.submittedAt, created_at: app.createdAt, updated_at: new Date().toISOString() });
    }
    let result;
    try {
      result = await db.query(
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
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[candidateApplicationService] approve fallback mock:', e.message);
        return this.formatApplication({ id, student_id: app.studentId || app.student_id, full_name: app.fullName, enrollment_number: app.enrollmentNumber, department: app.department, year: app.year, semester: app.semester, section: app.section, position_id: context._positionId || app.positionId || null, contesting_position: app.contestingPosition, email: app.email, phone: app.phone, profile_photo_url: app.profilePhotoUrl, bio: app.bio, manifesto: app.manifesto, age: app.age, date_of_birth: app.dateOfBirth, gender: app.gender, aadhar_number: app.aadharNumber, category: app.category, election_id: crElectionId || app.electionId || null, status: 'approved', reviewed_by: adminId, submitted_at: app.submittedAt, created_at: app.createdAt, updated_at: new Date().toISOString() });
      }
      throw e;
    }

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
      try {
        await db.query(
          `UPDATE students SET role = 'CANDIDATE', updated_at = NOW()
           WHERE id = $1 AND role IN ('STUDENT', 'CANDIDATE')`,
          [appId]
        );
      } catch (e) {
        if (!isMongoOnly) throw e;
        console.warn('[candidateApplicationService] approve role update mongo skip:', e.message);
      }
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
          if (!isMongoOnly) throw err;
          console.warn('[candidateApplicationService] approve ballot fallback:', err.message);
        } else {
          console.warn(
            'approve: could not create candidates ballot row',
            { applicationId: id, positionId: result.rows[0].position_id, code: err.code }
          );
        }
      }
    }

    await candidateService.invalidateCandidates();
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
          !match(constituency.year, normalizeYear(app.year)) ||
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
            year: normalizeYear(app.year),
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
          year: normalizeYear(app.year),
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

    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            const updates = { election_id: electionId, electionId, position_id: crPosition.id, positionId: crPosition.id, updated_at: new Date(), updatedAt: new Date() };
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)), status: 'approved' }, { $set: updates }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ $or: [{ id: String(id) }, { _id: String(id) }], status: 'approved' }, { $set: updates }, { returnDocument: 'after' });
            if (res && res.value) {
              try { await candidateService.create({ position_id: res.value.position_id ?? res.value.positionId, name: res.value.full_name ?? res.value.fullName, description: res.value.bio || res.value.manifesto || null, image_url: (res.value.profile_photo_url ?? res.value.profilePhotoUrl) || null }); } catch (_) {}
              const doc = res.value;
              const mapped = { id: doc._id ? String(doc._id) : doc.id, student_id: doc.student_id ?? doc.studentId, full_name: doc.full_name ?? doc.fullName, enrollment_number: doc.enrollment_number ?? doc.enrollmentNumber, department: doc.department, year: doc.year, semester: doc.semester, section: doc.section, position_id: doc.position_id ?? doc.positionId, contesting_position: doc.contesting_position ?? doc.contestingPosition, email: doc.email, phone: doc.phone, profile_photo_url: doc.profile_photo_url ?? doc.profilePhotoUrl, bio: doc.bio, manifesto: doc.manifesto, age: doc.age, date_of_birth: doc.date_of_birth ?? doc.dateOfBirth, gender: doc.gender, aadhar_number: doc.aadhar_number ?? doc.aadharNumber, category: doc.category || 'CR', election_id: doc.election_id ?? doc.electionId, status: doc.status, rejection_reason: doc.rejection_reason, changes_requested_reason: doc.changes_requested_reason, reviewed_by: doc.reviewed_by, submitted_at: doc.submitted_at, created_at: doc.created_at, updated_at: doc.updated_at };
              return this.formatApplication(mapped);
            }
          } finally {}        }
      } catch (e) {
        console.warn('[candidateApplicationService] assignBallot mongo fallback:', e.message);
        if (e.code) throw e;
      }
      return this.formatApplication({ id, student_id: app.studentId, full_name: app.fullName, enrollment_number: app.enrollmentNumber, department: app.department, year: app.year, semester: app.semester, section: app.section, position_id: crPosition.id, contesting_position: app.contestingPosition, email: app.email, phone: app.phone, profile_photo_url: app.profilePhotoUrl, bio: app.bio, manifesto: app.manifesto, age: app.age, date_of_birth: app.dateOfBirth, gender: app.gender, aadhar_number: app.aadharNumber, category: app.category, election_id: electionId, status: 'approved', submitted_at: app.submittedAt, created_at: app.createdAt, updated_at: new Date().toISOString() });
    }
    let result;
    try {
      result = await db.query(
        `UPDATE candidate_applications
         SET election_id = $2,
             position_id = $3,
             updated_at = NOW()
         WHERE id = $1 AND status = 'approved'
         RETURNING *`,
        [id, electionId, crPosition.id]
      );
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[candidateApplicationService] assignBallot fallback mock:', e.message);
        return this.formatApplication({ id, student_id: app.studentId, full_name: app.fullName, enrollment_number: app.enrollmentNumber, department: app.department, year: app.year, semester: app.semester, section: app.section, position_id: crPosition.id, contesting_position: app.contestingPosition, email: app.email, phone: app.phone, profile_photo_url: app.profilePhotoUrl, bio: app.bio, manifesto: app.manifesto, age: app.age, date_of_birth: app.dateOfBirth, gender: app.gender, aadhar_number: app.aadharNumber, category: app.category, election_id: electionId, status: 'approved', submitted_at: app.submittedAt, created_at: app.createdAt, updated_at: new Date().toISOString() });
      }
      throw e;
    }

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
        if (!isMongoOnly) throw err;
        console.warn('[candidateApplicationService] assignBallot ballot fallback:', err.message);
      } else {
        console.warn(
          'assignBallot: could not create candidates ballot row',
          { applicationId: id, positionId: result.rows[0].position_id, code: err.code }
        );
      }
    }

    await candidateService.invalidateCandidates();
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
    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            const pending = await col.find({ status: 'approved', $or: [{ category: 'CR' }, { category: 'CLASS_REPRESENTATIVE' }], $or: [{ election_id: null }, { position_id: null }, { electionId: null }, { positionId: null }] }).limit(100).toArray();
            const placed = []; const skipped = [];
            for (const doc of pending) {
              try {
                const aid = doc._id ? String(doc._id) : doc.id;
                const app = await this.getById(aid);
                if (!app) { skipped.push(aid); continue; }
                const constituency = await constituencyService.findMatching({ electionId, department: app.department, year: normalizeYear(app.year), section: app.section || '', activeOnly: true });
                if (!constituency) { skipped.push(aid); continue; }
                await this.assignBallot(aid, { electionId, constituencyId: constituency.id });
                placed.push(aid);
              } catch (err) { skipped.push(doc._id ? String(doc._id) : doc.id); }
            }
            return { placed, skipped };
          } finally {}        }
      } catch (e) { console.warn('[candidateApplicationService] placeUnplacedForElection mongo fallback:', e.message); }
      return { placed: [], skipped: [] };
    }
    let pending;
    try {
      pending = await db.query(
        `SELECT id FROM candidate_applications
         WHERE status = 'approved'
           AND (category = 'CR' OR category = 'CLASS_REPRESENTATIVE')
           AND (election_id IS NULL OR position_id IS NULL)`
      );
    } catch (e) {
      if (isMongoOnly) return { placed: [], skipped: [] };
      throw e;
    }

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
          year: normalizeYear(app.year),
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

    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            const updates = { status: 'rejected', rejection_reason: reason, rejectionReason: reason, reviewed_by: adminId, reviewedBy: adminId, reviewed_at: new Date(), reviewedAt: new Date(), updated_at: new Date(), updatedAt: new Date() };
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)), status: 'under_review' }, { $set: updates }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ $or: [{ id: String(id) }, { _id: String(id) }], status: 'under_review' }, { $set: updates }, { returnDocument: 'after' });
            if (res && res.value) {
              const doc = res.value;
              const mapped = { id: doc._id ? String(doc._id) : doc.id, student_id: doc.student_id ?? doc.studentId, full_name: doc.full_name ?? doc.fullName, enrollment_number: doc.enrollment_number ?? doc.enrollmentNumber, department: doc.department, year: doc.year, semester: doc.semester, section: doc.section, position_id: doc.position_id ?? doc.positionId, contesting_position: doc.contesting_position ?? doc.contestingPosition, email: doc.email, phone: doc.phone, profile_photo_url: doc.profile_photo_url ?? doc.profilePhotoUrl, bio: doc.bio, manifesto: doc.manifesto, age: doc.age, date_of_birth: doc.date_of_birth ?? doc.dateOfBirth, gender: doc.gender, aadhar_number: doc.aadhar_number ?? doc.aadharNumber, category: doc.category || 'CR', election_id: doc.election_id ?? doc.electionId, status: doc.status, rejection_reason: doc.rejection_reason ?? doc.rejectionReason, reviewed_by: doc.reviewed_by ?? doc.reviewedBy, submitted_at: doc.submitted_at, created_at: doc.created_at, updated_at: doc.updated_at };
              return this.formatApplication(mapped);
            }
          } finally {}        }
      } catch (e) {
        console.warn('[candidateApplicationService] reject mongo fallback:', e.message);
        if (e.code) throw e;
      }
      return this.formatApplication({ id, student_id: app.studentId, full_name: app.fullName, enrollment_number: app.enrollmentNumber, department: app.department, year: app.year, semester: app.semester, section: app.section, position_id: app.positionId, contesting_position: app.contestingPosition, email: app.email, phone: app.phone, profile_photo_url: app.profilePhotoUrl, bio: app.bio, manifesto: app.manifesto, age: app.age, date_of_birth: app.dateOfBirth, gender: app.gender, aadhar_number: app.aadharNumber, category: app.category, election_id: app.electionId, status: 'rejected', rejection_reason: reason, reviewed_by: adminId, submitted_at: app.submittedAt, created_at: app.createdAt, updated_at: new Date().toISOString() });
    }
    let result;
    try {
      result = await db.query(
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
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[candidateApplicationService] reject fallback mock:', e.message);
        return this.formatApplication({ id, student_id: app.studentId, full_name: app.fullName, enrollment_number: app.enrollmentNumber, department: app.department, year: app.year, semester: app.semester, section: app.section, position_id: app.positionId, contesting_position: app.contestingPosition, email: app.email, phone: app.phone, profile_photo_url: app.profilePhotoUrl, bio: app.bio, manifesto: app.manifesto, age: app.age, date_of_birth: app.dateOfBirth, gender: app.gender, aadhar_number: app.aadharNumber, category: app.category, election_id: app.electionId, status: 'rejected', rejection_reason: reason, reviewed_by: adminId, submitted_at: app.submittedAt, created_at: app.createdAt, updated_at: new Date().toISOString() });
      }
      throw e;
    }

    // If this applicant was promoted by a previous approval that was later
    // reversed, drop them back to STUDENT (never touch ADMIN/CAD accounts).
    const appId = result.rows[0].student_id;
    if (appId) {
      try {
        await db.query(
          `UPDATE students SET role = 'STUDENT', updated_at = NOW()
           WHERE id = $1 AND role = 'CANDIDATE'`,
          [appId]
        );
      } catch (e) { if (!isMongoOnly) throw e; console.warn('[candidateApplicationService] reject role fallback:', e.message); }
    }

    // Remove the ballot row this applicant may have earned when they were
    // approved, so a reversed approval does not leave them contesting on the
    // ballot. Scoped by position (required) and name (the person).
    if (result.rows[0].position_id && result.rows[0].full_name) {
      try {
        await db.query(
          `DELETE FROM candidates
           WHERE position_id = $1 AND name = $2`,
          [result.rows[0].position_id, result.rows[0].full_name]
        );
      } catch (e) { if (!isMongoOnly) throw e; console.warn('[candidateApplicationService] reject delete candidates fallback:', e.message); }
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

    if (isMongoOnly) {
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            const updates = { status: 'changes_requested', changes_requested_reason: reason, changesRequestedReason: reason, reviewed_by: adminId, reviewedBy: adminId, reviewed_at: new Date(), reviewedAt: new Date(), updated_at: new Date(), updatedAt: new Date() };
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)), status: 'under_review' }, { $set: updates }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ $or: [{ id: String(id) }, { _id: String(id) }], status: 'under_review' }, { $set: updates }, { returnDocument: 'after' });
            if (res && res.value) {
              const doc = res.value;
              const mapped = { id: doc._id ? String(doc._id) : doc.id, student_id: doc.student_id ?? doc.studentId, full_name: doc.full_name ?? doc.fullName, enrollment_number: doc.enrollment_number ?? doc.enrollmentNumber, department: doc.department, year: doc.year, semester: doc.semester, section: doc.section, position_id: doc.position_id ?? doc.positionId, contesting_position: doc.contesting_position ?? doc.contestingPosition, email: doc.email, phone: doc.phone, profile_photo_url: doc.profile_photo_url ?? doc.profilePhotoUrl, bio: doc.bio, manifesto: doc.manifesto, age: doc.age, date_of_birth: doc.date_of_birth ?? doc.dateOfBirth, gender: doc.gender, aadhar_number: doc.aadhar_number ?? doc.aadharNumber, category: doc.category || 'CR', election_id: doc.election_id ?? doc.electionId, status: doc.status, changes_requested_reason: doc.changes_requested_reason ?? doc.changesRequestedReason, reviewed_by: doc.reviewed_by ?? doc.reviewedBy, submitted_at: doc.submitted_at, created_at: doc.created_at, updated_at: doc.updated_at };
              return this.formatApplication(mapped);
            }
          } finally {}        }
      } catch (e) {
        console.warn('[candidateApplicationService] requestChanges mongo fallback:', e.message);
        if (e.code) throw e;
      }
      return this.formatApplication({ id, student_id: app.studentId, full_name: app.fullName, enrollment_number: app.enrollmentNumber, department: app.department, year: app.year, semester: app.semester, section: app.section, position_id: app.positionId, contesting_position: app.contestingPosition, email: app.email, phone: app.phone, profile_photo_url: app.profilePhotoUrl, bio: app.bio, manifesto: app.manifesto, age: app.age, date_of_birth: app.dateOfBirth, gender: app.gender, aadhar_number: app.aadharNumber, category: app.category, election_id: app.electionId, status: 'changes_requested', changes_requested_reason: reason, reviewed_by: adminId, submitted_at: app.submittedAt, created_at: app.createdAt, updated_at: new Date().toISOString() });
    }
    let result;
    try {
      result = await db.query(
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
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[candidateApplicationService] requestChanges fallback mock:', e.message);
        return this.formatApplication({ id, student_id: app.studentId, full_name: app.fullName, enrollment_number: app.enrollmentNumber, department: app.department, year: app.year, semester: app.semester, section: app.section, position_id: app.positionId, contesting_position: app.contestingPosition, email: app.email, phone: app.phone, profile_photo_url: app.profilePhotoUrl, bio: app.bio, manifesto: app.manifesto, age: app.age, date_of_birth: app.dateOfBirth, gender: app.gender, aadhar_number: app.aadharNumber, category: app.category, election_id: app.electionId, status: 'changes_requested', changes_requested_reason: reason, reviewed_by: adminId, submitted_at: app.submittedAt, created_at: app.createdAt, updated_at: new Date().toISOString() });
      }
      throw e;
    }

    return this.formatApplication(result.rows[0]);
  }

  /**
   * Resubmit application (candidate updates after changes_requested)
   */
  async resubmit(id, data, studentId) {
    if (isMongoOnly) {
      const app = await this.getById(id);
      if (!app) {
        const error = new Error('Application not found.');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      if (app.status !== 'changes_requested') {
        const error = new Error('Application can only be resubmitted when changes are requested.');
        error.code = 'INVALID_STATUS';
        error.status = 400;
        throw error;
      }
      if (String(app.studentId) !== String(studentId)) {
        const error = new Error('You can only update your own application.');
        error.code = 'FORBIDDEN';
        error.status = 403;
        throw error;
      }
      const { bio, manifesto, profilePhotoUrl, email, phone } = data;
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            const updates = { status: 'under_review', updated_at: new Date(), updatedAt: new Date(), changes_requested_reason: null, changesRequestedReason: null, reviewed_by: null, reviewedBy: null };
            if (bio !== undefined) { updates.bio = bio; }
            if (manifesto !== undefined) updates.manifesto = manifesto;
            if (profilePhotoUrl !== undefined) { updates.profile_photo_url = profilePhotoUrl; updates.profilePhotoUrl = profilePhotoUrl; }
            if (email !== undefined) updates.email = email;
            if (phone !== undefined) updates.phone = phone;
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: updates }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ id: String(id) }, { $set: updates }, { returnDocument: 'after' });
            if (res && res.value) {
              const doc = res.value;
              const mapped = { id: doc._id ? String(doc._id) : doc.id, student_id: doc.student_id ?? doc.studentId, full_name: doc.full_name ?? doc.fullName, enrollment_number: doc.enrollment_number ?? doc.enrollmentNumber, department: doc.department, year: doc.year, semester: doc.semester, section: doc.section, position_id: doc.position_id ?? doc.positionId, contesting_position: doc.contesting_position ?? doc.contestingPosition, email: doc.email, phone: doc.phone, profile_photo_url: doc.profile_photo_url ?? doc.profilePhotoUrl, bio: doc.bio, manifesto: doc.manifesto, age: doc.age, date_of_birth: doc.date_of_birth ?? doc.dateOfBirth, gender: doc.gender, aadhar_number: doc.aadhar_number ?? doc.aadharNumber, category: doc.category || 'CR', election_id: doc.election_id ?? doc.electionId, status: doc.status, rejection_reason: doc.rejection_reason, changes_requested_reason: doc.changes_requested_reason, reviewed_by: doc.reviewed_by, submitted_at: doc.submitted_at, created_at: doc.created_at, updated_at: doc.updated_at };
              return this.formatApplication(mapped);
            }
          } finally {}        }
      } catch (e) {
        console.warn('[candidateApplicationService] resubmit mongo fallback:', e.message);
        if (e.code) throw e;
      }
      return app;
    }
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
    if (isMongoOnly) {
      const app = await this.getById(id);
      if (!app) {
        const error = new Error('Application not found.');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      if (String(app.studentId) !== String(studentId)) {
        const error = new Error('You can only update your own application.');
        error.code = 'FORBIDDEN';
        error.status = 403;
        throw error;
      }
      if (app.status !== 'approved') {
        const error = new Error('Profile can only be updated after approval.');
        error.code = 'NOT_APPROVED';
        error.status = 403;
        throw error;
      }
      const { bio, manifesto, profilePhotoUrl } = data;
      try {
        const client = await getSharedClient();
        if (client) {
          try {            const col = client.db(getMongoDbName()).collection('candidate_applications');
            const updates = { updated_at: new Date(), updatedAt: new Date() };
            if (bio !== undefined) updates.bio = bio;
            if (manifesto !== undefined) updates.manifesto = manifesto;
            if (profilePhotoUrl !== undefined) { updates.profile_photo_url = profilePhotoUrl === '' ? null : profilePhotoUrl; updates.profilePhotoUrl = profilePhotoUrl === '' ? null : profilePhotoUrl; }
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: updates }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ id: String(id) }, { $set: updates }, { returnDocument: 'after' });
            if (res && res.value) {
              const doc = res.value;
              const mapped = { id: doc._id ? String(doc._id) : doc.id, student_id: doc.student_id ?? doc.studentId, full_name: doc.full_name ?? doc.fullName, enrollment_number: doc.enrollment_number ?? doc.enrollmentNumber, department: doc.department, year: doc.year, semester: doc.semester, section: doc.section, position_id: doc.position_id ?? doc.positionId, contesting_position: doc.contesting_position ?? doc.contestingPosition, email: doc.email, phone: doc.phone, profile_photo_url: doc.profile_photo_url ?? doc.profilePhotoUrl, bio: doc.bio, manifesto: doc.manifesto, age: doc.age, date_of_birth: doc.date_of_birth ?? doc.dateOfBirth, gender: doc.gender, aadhar_number: doc.aadhar_number ?? doc.aadharNumber, category: doc.category || 'CR', election_id: doc.election_id ?? doc.electionId, status: doc.status, rejection_reason: doc.rejection_reason, changes_requested_reason: doc.changes_requested_reason, reviewed_by: doc.reviewed_by, submitted_at: doc.submitted_at, created_at: doc.created_at, updated_at: doc.updated_at };
              return this.formatApplication(mapped);
            }
          } finally {}        }
      } catch (e) {
        console.warn('[candidateApplicationService] updateProfile mongo fallback:', e.message);
        if (e.code) throw e;
      }
      // Fallback mock success
      return { ...app, bio: data.bio ?? app.bio, manifesto: data.manifesto ?? app.manifesto, profilePhotoUrl: data.profilePhotoUrl ?? app.profilePhotoUrl };
    }
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
           profile_photo_url = CASE WHEN $3 = '' THEN NULL ELSE COALESCE($3, profile_photo_url) END,
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
    try {
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
    } catch (e) {
      if (isMongoOnly) {
        console.warn('[candidateApplicationService] getAccessInfo mongo fallback:', e.message);
        return { hasApplication: false, status: null, isApproved: false, canAccessCandidatePortal: false };
      }
      throw e;
    }
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
    if (isMongoOnly) {
      try {
        const rows = await this.listForAdmin({ status: 'approved', positionId: options.positionId, department: options.department, section: options.section, year: options.year, limit: 1000, offset: 0 });
        return rows.map(r => ({ id: r.id, student_id: r.studentId, full_name: r.fullName, gender: r.gender, department: r.department, year: r.year, section: r.section, position_id: r.positionId, category: r.category, photo: r.profilePhotoUrl, position_name: r.positionName, status: r.status }));
      } catch (e) {
        return [];
      }
    }
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
        ca.profile_photo_url AS photo,
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
      params.push(normalizeYear(year));
      paramIndex++;
    }

    query += ' ORDER BY ca.department, ca.year, ca.section, ca.full_name';

    try {
      const result = await db.query(query, params);
      return result.rows;
    } catch (e) {
      if (isMongoOnly) return [];
      throw e;
    }
  }
}

module.exports = new CandidateApplicationService();
