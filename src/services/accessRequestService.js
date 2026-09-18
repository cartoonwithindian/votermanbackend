/**
 * Access Request Service
 *
 * Public "Request Voting Access" pipeline:
 *   submit (dup-checked) -> pending -> admin approve/reject.
 *
 * Approval is the ONLY path that adds a student to the authorized list,
 * activates the account, and grants voting eligibility. Rejected/pending
 * students never get a usable login or voting rights.
 */
const db = require('../db');
const { recordAudit } = require('../lib/authDb');
const { hashPassword } = require('../lib/password');

const REASONS = ['not_in_list', 'cannot_access_email', 'incorrect_email', 'other'];

function normalizeEmail(v) {
  return String(v || '').toLowerCase().trim();
}

function validatePayload(b) {
  const errors = [];
  const full_name = String(b.fullName || '').trim().slice(0, 255);
  const student_id = String(b.studentId || '').trim();
  const roll_number = String(b.rollNumber || '').trim();
  const department = String(b.department || '').trim();
  const year_or_semester = String(b.yearOrSemester || '').trim();
  const section = String(b.section || '').trim().slice(0, 20);
  const college_email = normalizeEmail(b.collegeEmail);
  const accessible_email = normalizeEmail(b.accessibleEmail);
  const phone = String(b.phone || '').replace(/[\s()-]/g, '').trim();
  const request_reason = REASONS.includes(b.reason) ? b.reason : 'other';
  const reason_detail = String(b.reasonDetail || '').trim().slice(0, 2000);

  // The student is identified by their registered college email (old mail);
  // the accessible email is the new mail they want to sign in with.
  if (student_id.length > 64) errors.push('Student ID must be at most 64 chars.');
  if (roll_number.length > 64) errors.push('Roll number must be at most 64 chars.');
  if (department.length > 120) errors.push('Department must be at most 120 chars.');
  if (year_or_semester.length > 40) errors.push('Year/Semester must be at most 40 chars.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(college_email)) errors.push('A valid registered college email is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accessible_email)) errors.push('A valid accessible email is required.');
  if (!/^\+?[0-9]{10,15}$/.test(phone)) errors.push('A valid phone number (10-15 digits, optional + prefix) is required.');

  return {
    errors,
    data: { full_name, student_id, roll_number, department, year_or_semester, section, college_email, accessible_email, phone, request_reason, reason_detail },
  };
}

/**
 * Auto-detect the whitelist record (student_id + registered college email)
 * from the student's registered college email ("old mail"). The self-service
 * form no longer asks for Student ID or the full name, so we resolve the
 * student identity by their registered email only — name + class are NOT
 * checked, which avoids same-name ambiguity (e.g. two "Bhumika" in BCA).
 * Returns null when no whitelist row owns that email (admin resolves it).
 */
async function resolveWhitelistMatch({ college_email }) {
  const email = normalizeEmail(college_email);
  if (!email) return null;

  const row = await db.query(
    `SELECT id, student_id, external_id, name, email, official_email, current_login_email,
            department, year_or_semester, section
       FROM students
      WHERE LOWER(current_login_email) = LOWER($1)
         OR LOWER(official_email) = LOWER($1)
         OR LOWER(email) = LOWER($1)
      LIMIT 1`,
    [email]
  ).then((r) => r.rows[0] || null);
  if (!row) return null;

  return {
    id: row.id,
    student_id: row.student_id || row.external_id || null,
    college_email: row.official_email || row.email || row.current_login_email || null,
    current_login_email: row.current_login_email || null,
    official_email: row.official_email || null,
    email: row.email || null,
    matched_name: row.name,
    department: row.department || null,
    year_or_semester: row.year_or_semester || null,
    section: row.section || null,
  };
}

/**
 * Duplicate rules (spec §8), extended for email-change requests:
 *  - student matched by their registered email AND their accessible email
 *    already signs them in no change is needed                       -> ALREADY_AUTHORIZED
 *  - whitelist row matched by registered email but the accessible email
 *    is NEW                                                         -> email-change request (allow)
 *  - college or accessible email already belongs to a different account -> EMAIL_EXISTS
 *  - same student has a pending request                               -> PENDING_EXISTS
 *  - identical pending request from anyone                            -> PENDING_EXISTS
 */
async function findDuplicate(payload, matched) {
  const { student_id, college_email, accessible_email } = payload;
  const acc = normalizeEmail(accessible_email);

  // ----- Whitelist row resolved from the registered college email -----
  if (matched && matched.id) {
    const mine = [matched.current_login_email, matched.official_email, matched.email]
      .filter(Boolean).map((e) => normalizeEmail(e));

    // They can already sign in with that exact email — no change required.
    if (mine.includes(acc)) {
      return { code: 'ALREADY_AUTHORIZED', student: matched };
    }

    // The new accessible email must not already belong to another student.
    const other = await db.query(
      `SELECT id FROM students
        WHERE id <> $1
          AND (LOWER(current_login_email) = LOWER($2)
            OR LOWER(official_email) = LOWER($2)
            OR LOWER(email) = LOWER($2))
        LIMIT 1`,
      [matched.id, acc]
    ).then((r) => r.rows[0] || null);
    if (other) return { code: 'EMAIL_EXISTS' };

    // No live duplicate → this is an email/access change request. Allow it;
    // admin approval will update the existing student instead of adding a new one.
    const pending = await db.query(
      `SELECT id FROM student_access_requests
        WHERE status = 'pending'
          AND (($1::text <> '' AND LOWER(student_id) = LOWER($1))
            OR LOWER(accessible_email) = LOWER($2))
        LIMIT 1`,
      [student_id || '', acc]
    ).then((r) => r.rows[0] || null);
    if (pending) return { code: 'PENDING_EXISTS' };

    return null;
  }

  // ----- Unknown student (no whitelist match) -----
  if (student_id) {
    const student = await db.query(
      `SELECT id, student_id, external_id, is_active FROM students
        WHERE LOWER(student_id) = LOWER($1) OR LOWER(external_id) = LOWER($1)
        LIMIT 1`,
      [student_id]
    ).then((r) => r.rows[0] || null);
    if (student) return { code: 'ALREADY_AUTHORIZED', student };
  }

  if (college_email) {
    const email = await db.query(
      `SELECT id FROM students
        WHERE LOWER(current_login_email) = LOWER($1)
           OR LOWER(official_email) = LOWER($1)
           OR LOWER(email) = LOWER($1)
        LIMIT 1`,
      [college_email]
    ).then((r) => r.rows[0] || null);
    if (email) return { code: 'EMAIL_EXISTS' };
  }

  const email2 = await db.query(
    `SELECT id FROM students
      WHERE LOWER(current_login_email) = LOWER($1)
         OR LOWER(official_email) = LOWER($1)
         OR LOWER(email) = LOWER($1)
      LIMIT 1`,
    [acc]
  ).then((r) => r.rows[0] || null);
  if (email2) return { code: 'EMAIL_EXISTS' };

  const pending = await db.query(
    `SELECT id FROM student_access_requests
      WHERE status = 'pending'
        AND (($1::text IS NOT NULL AND LOWER(student_id) = LOWER($1))
          OR LOWER(accessible_email) = LOWER($2)
          OR ($3::text IS NOT NULL AND LOWER(college_email) = LOWER($3)))
      LIMIT 1`,
    [student_id || null, acc, college_email || null]
  ).then((r) => r.rows[0] || null);
  if (pending) return { code: 'PENDING_EXISTS' };

  return null;
}

async function submitRequest(payload, ip) {
  const resolved = await resolveWhitelistMatch(payload);
  const student_id = payload.student_id || (resolved && resolved.student_id) || null;
  const college_email = payload.college_email || (resolved && resolved.college_email) || null;
  // Full name is auto-filled from the matched whitelist row; the form itself
  // no longer asks for it.
  const full_name = payload.full_name || (resolved && resolved.matched_name) || null;
  const request = { ...payload, full_name, student_id, college_email, matched_name: resolved ? resolved.matched_name : null };

  const dup = await findDuplicate(request, resolved);
  if (dup) return { ok: false, code: dup.code };

  const d = request;
  const inserted = await db.query(
    `INSERT INTO student_access_requests
       (full_name, student_id, roll_number, department, year_or_semester, section,
        college_email, accessible_email, phone, request_reason, reason_detail, status, request_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
     RETURNING id, created_at`,
    [d.full_name, d.student_id || null, d.roll_number || null, d.department || null,
     d.year_or_semester || null, d.section || null,
     d.college_email, d.accessible_email, d.phone, d.request_reason, d.reason_detail, ip || null]
  ).then((r) => r.rows[0]);

  await recordAudit('access_request_submitted', {
    studentId: null,
    ip,
    metadata: { requestId: inserted.id, studentId: d.student_id, accessibleEmail: d.accessible_email, matchedWhitelist: !!resolved },
  });

  return { ok: true, request: inserted, matched: resolved || null };
}

/**
 * Status lookup requires the registered (old) email AND the accessible (new)
 * email, so a stranger can't probe arbitrary requests by knowing just one value.
 */
async function checkStatus(collegeEmail, accessibleEmail) {
  const row = await db.query(
    `SELECT id, full_name, student_id, status, rejection_reason, created_at, reviewed_at
       FROM student_access_requests
      WHERE LOWER(college_email) = LOWER($1) AND LOWER(accessible_email) = LOWER($2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [normalizeEmail(collegeEmail), normalizeEmail(accessibleEmail)]
  ).then((r) => r.rows[0] || null);
  return row;
}

async function listRequests({ status, limit } = {}) {
  const safeStatus = ['pending', 'approved', 'rejected'].includes(status) ? status : null;
  const rows = await db.query(
    `SELECT sar.*, rev.name AS reviewed_by_name
       FROM student_access_requests sar
       LEFT JOIN students rev ON rev.id = sar.reviewed_by
      WHERE ($1::text IS NULL OR sar.status = $1)
      ORDER BY CASE WHEN sar.status = 'pending' THEN 0 ELSE 1 END, sar.created_at DESC
      LIMIT $2`,
    [safeStatus, Math.min(parseInt(limit, 10) || 100, 500)]
  );
  const counts = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM student_access_requests GROUP BY status`
  );
  return {
    requests: rows.rows,
    counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.count])),
  };
}

async function getRequest(id) {
  return db.query(
    `SELECT sar.*, rev.name AS reviewed_by_name
       FROM student_access_requests sar
       LEFT JOIN students rev ON rev.id = sar.reviewed_by
      WHERE sar.id = $1`,
    [id]
  ).then((r) => r.rows[0] || null);
}

/**
 * Admin approval (spec §4 Approve + §5):
 *   verify -> create/activate student -> authorize -> mark approved.
 * Everything happens in ONE transaction on ONE connection.
 */
async function approveRequest(requestId, admin, note, ip) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const req = await client.query(
      `SELECT * FROM student_access_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [requestId]
    ).then((r) => r.rows[0]);

    if (!req) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Pending request not found (it may already have been reviewed).' };
    }

    const newEmail = normalizeEmail(req.accessible_email);

    // Guard: the accessible email must not already belong to another account
    const clash = await client.query(
      `SELECT id FROM students
        WHERE LOWER(current_login_email) = LOWER($1)
           OR LOWER(official_email) = LOWER($1)
           OR LOWER(email) = LOWER($1)
        LIMIT 1`,
      [newEmail]
    ).then((r) => r.rows[0]);

    if (clash) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, code: 'EMAIL_IN_USE', message: 'The accessible email is already linked to an account.' };
    }

    // Create or activate the student (approval = added to authorized list)
    const studentIdKey = req.student_id || `SAR-${String(req.id || '')}`;
    const externalId = req.student_id ? `SAR-${studentIdKey}` : studentIdKey;
    const existing = studentIdKey
      ? await client.query(
          `SELECT id, is_active FROM students
            WHERE LOWER(student_id) = LOWER($1) OR LOWER(external_id) = LOWER($1)
            LIMIT 1`,
          [studentIdKey]
        ).then((r) => r.rows[0])
      : null;

    let student;
    if (existing) {
      // Email swap: keep the registered (old) mail as official_email, and switch
      // login to the accessible (new) mail. Also persist roll/section/phone.
      const updated = await client.query(
        `UPDATE students SET
           name = COALESCE(NULLIF($2,''), name),
           roll_number = $3, department = $4, year_or_semester = $5, section = $6,
           mobile_number = $7,
           official_email = COALESCE(NULLIF($8,''), official_email),
           current_login_email = $9, email = $9,
           email_verified = TRUE, is_active = TRUE, voting_eligible = TRUE,
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existing.id, req.full_name, req.roll_number || null, req.department || null,
         req.year_or_semester || null, req.section || null, req.phone || null,
         req.college_email || '', newEmail]
      ).then((r) => r.rows[0]);
      student = updated;
    } else {
      const usernameBase = String(req.full_name || newEmail.split('@')[0])
        .replace(/[^a-z0-9._-]/gi, '').toLowerCase() || 'student';
      const username = `${usernameBase}.${Date.now().toString(36)}`;
      const randomPassword = require('node:crypto').randomBytes(24).toString('base64url');
      const passwordHash = await hashPassword(randomPassword);
      const inserted = await client.query(
        `INSERT INTO students
           (external_id, name, email, password_hash, role, is_active,
            student_id, official_email, current_login_email, email_verified,
            roll_number, department, year_or_semester, section, mobile_number, voting_eligible, username)
         VALUES ($1,COALESCE(NULLIF($2,''), split_part($3,'@',1)),$3,$4,'STUDENT',TRUE,$5,$6,$3,TRUE,$7,$8,$9,$10,$11,TRUE,$12)
         RETURNING *`,
        [externalId, req.full_name, newEmail, passwordHash,
         studentIdKey, req.college_email || newEmail, req.roll_number || null,
         req.department || null, req.year_or_semester || null, req.section || null,
         req.phone || null, username]
      ).then((r) => r.rows[0]);
      student = inserted;
    }

    // Mark request approved + record reviewer
    await client.query(
      `UPDATE student_access_requests
          SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(),
              rejection_reason = NULL, created_student = $3, updated_at = NOW()
        WHERE id = $1`,
      [requestId, admin.studentId, student.id]
    );

    await client.query('COMMIT');

    await recordAudit('access_request_approved', {
      studentId: admin.studentId,
      ip,
      metadata: { requestId, createdStudentId: student.id, studentKey: studentIdKey, note: note || null },
    });

    return { ok: true, student };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function rejectRequest(requestId, admin, rejectionReason, ip) {
  const clean = String(rejectionReason || '').trim().slice(0, 1000);
  if (!clean) {
    return { ok: false, status: 400, code: 'REASON_REQUIRED', message: 'A rejection reason is required.' };
  }

  const updated = await db.query(
    `UPDATE student_access_requests
        SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(),
            rejection_reason = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING id, student_id, accessible_email`,
    [requestId, admin.studentId, clean]
  ).then((r) => r.rows[0] || null);

  if (!updated) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Pending request not found (it may already have been reviewed).' };
  }

  await recordAudit('access_request_rejected', {
    studentId: admin.studentId,
    ip,
    metadata: { requestId, rejectionReason: clean.slice(0, 200) },
  });

  return { ok: true, request: updated };
}

module.exports = {
  REASONS,
  validatePayload,
  submitRequest,
  checkStatus,
  listRequests,
  getRequest,
  approveRequest,
  rejectRequest,
};
