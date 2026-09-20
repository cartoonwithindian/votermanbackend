/**
 * Admin — Email Change Request review
 *
 * GET    /api/v1/admin/email-recovery          list requests (status filter)
 * GET    /api/v1/admin/email-recovery/:id      single request + student snapshot
 * POST   /api/v1/admin/email-recovery/:id/approve  verify identity, approve, switch login email
 * POST   /api/v1/admin/email-recovery/:id/reject   reject with note
 *
 * Approve flow: identity fields provided by the admin MUST match the student
 * record (name case-insensitive, student_id/roll number case-insensitive).
 * On success, current_login_email (and email) switch to the requested new
 * email; official_email keeps the original institute address. Identity and
 * voting eligibility are untouched — they live on the student id.
 */
const express = require('express');
const router = express.Router();

const db = require('../db');
const { recordAudit, publicUser } = require('../lib/authDb');
const { csrfProtection } = require('../middleware/csrfProtection');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

function err(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// ---- GET / (list, ?status=pending|approved|rejected) ----
router.get('/', async (req, res) => {
  if (isMongoOnly) {
    return res.json({ data: { requests: [], counts: {} } });
  }
  try {
    const status = ['pending', 'approved', 'rejected'].includes(String(req.query.status))
      ? String(req.query.status)
      : null;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const rows = await db.query(
      `SELECT ecr.id, ecr.old_email, ecr.requested_new_email, ecr.reason,
              ecr.status, ecr.review_note, ecr.reviewed_at, ecr.created_at,
              s.id AS student_db_id, s.student_id, s.name, s.email AS current_email,
              s.official_email, s.role, s.is_active,
              reviewer.name AS reviewed_by_name
         FROM email_change_requests ecr
         LEFT JOIN students s ON s.id = ecr.student_id
         LEFT JOIN students reviewer ON reviewer.id = ecr.reviewed_by
        WHERE ($1::text IS NULL OR ecr.status = $1)
        ORDER BY CASE WHEN ecr.status = 'pending' THEN 0 ELSE 1 END, ecr.created_at DESC
        LIMIT $2`,
      [status, limit]
    );

    const counts = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM email_change_requests GROUP BY status`
    );

    return res.json({
      data: {
        requests: rows.rows,
        counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.count])),
      },
    });
  } catch (error) {
    console.error('list email change requests failed:', error);
    return err(res, 500, 'INTERNAL_ERROR', 'Could not load requests.');
  }
});

// ---- GET /:id ----
router.get('/:id', async (req, res) => {
  if (isMongoOnly) {
    return err(res, 404, 'NOT_FOUND', 'Request not found.');
  }
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return err(res, 400, 'INVALID_ID', 'Invalid request id.');

    const row = await db.query(
      `SELECT ecr.*, s.name, s.student_id, s.official_email, s.email AS current_email,
              s.role, s.is_active
         FROM email_change_requests ecr
         LEFT JOIN students s ON s.id = ecr.student_id
        WHERE ecr.id = $1`,
      [id]
    );

    if (!row.rows[0]) return err(res, 404, 'NOT_FOUND', 'Request not found.');
    return res.json({ data: { request: row.rows[0] } });
  } catch (error) {
    console.error('get email change request failed:', error);
    return err(res, 500, 'INTERNAL_ERROR', 'Could not load request.');
  }
});

// ---- POST /:id/approve ----
router.post('/:id/approve', csrfProtection, async (req, res) => {
  if (isMongoOnly) {
    return err(res, 404, 'NOT_FOUND', 'Pending request not found (Mongo-only mode).');
  }
  let client = null;
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return err(res, 400, 'INVALID_ID', 'Invalid request id.');

    const verifyName = String(req.body.verifyName || '').trim();
    const verifyStudentRef = String(req.body.verifyStudentRef || '').trim();
    const note = String(req.body.note || '').trim().slice(0, 1000);

    if (!verifyName || !verifyStudentRef) {
      return err(res, 400, 'IDENTITY_REQUIRED', 'Student name and student ID / roll number are required to verify identity.');
    }

    // Everything from here runs on ONE connection so FOR UPDATE + UPDATE are atomic
    client = await db.pool.connect();
    await client.query('BEGIN');

    const request = await client.query(
      `SELECT * FROM email_change_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [id]
    ).then((r) => r.rows[0]);

    if (!request) {
      await client.query('ROLLBACK');
      return err(res, 404, 'NOT_FOUND', 'Pending request not found (it may already have been reviewed).');
    }

    const student = await client.query(`SELECT * FROM students WHERE id = $1 FOR UPDATE`, [request.student_id]).then((r) => r.rows[0]);
    if (!student) {
      await client.query('ROLLBACK');
      return err(res, 404, 'STUDENT_NOT_FOUND', 'Linked student no longer exists.');
    }

    // ---- Identity verification: both fields must match ----
    const nameOk = verifyName.toLowerCase() === String(student.name || '').toLowerCase();
    const refOk =
      verifyStudentRef.toLowerCase() === String(student.student_id || '').toLowerCase() ||
      verifyStudentRef.toLowerCase() === String(student.external_id || '').toLowerCase();

    if (!nameOk || !refOk) {
      await client.query('ROLLBACK');
      await recordAudit('email_change_identity_mismatch', {
        studentId: student.id,
        ip: req.ip,
        metadata: { requestId: id, verifyName, verifyStudentRef },
      });
      return err(res, 403, 'IDENTITY_MISMATCH', 'Identity verification failed: name and student ID / roll number must match the student record.');
    }

    const newEmail = String(request.requested_new_email).toLowerCase().trim();

    // Guard: new email must not already belong to another active account
    const clash = await client.query(
      `SELECT id FROM students
        WHERE LOWER(current_login_email) = LOWER($1) AND id <> $2 AND is_active = TRUE
        LIMIT 1`,
      [newEmail, student.id]
    ).then((r) => r.rows[0]);

    if (clash) {
      await client.query('ROLLBACK');
      return err(res, 409, 'EMAIL_IN_USE', 'The new email is already linked to another account.');
    }

    // ---- Atomic switch ----
    await client.query(
      `UPDATE students
          SET current_login_email = $2,
              email = $2,
              email_verified = TRUE,
              updated_at = NOW()
        WHERE id = $1`,
      [student.id, newEmail]
    );
    await client.query(
      `UPDATE email_change_requests
          SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), review_note = $3, updated_at = NOW()
        WHERE id = $1`,
      [id, req.user.studentId, note || null]
    );
    await client.query('COMMIT');

    await recordAudit('email_change_approved', {
      studentId: student.id,
      ip: req.ip,
      metadata: { requestId: id, oldEmail: request.old_email, newEmail, reviewedBy: req.user.studentId },
    });

    return res.json({ data: { approved: true, studentId: student.id, newEmail } });
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('approve email change failed:', error);
    return err(res, 500, 'INTERNAL_ERROR', 'Could not approve the request.');
  } finally {
    if (client) client.release();
  }
});

// ---- POST /:id/reject ----
router.post('/:id/reject', csrfProtection, async (req, res) => {
  if (isMongoOnly) {
    return err(res, 404, 'NOT_FOUND', 'Pending request not found (Mongo-only mode).');
  }
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return err(res, 400, 'INVALID_ID', 'Invalid request id.');

    const note = String(req.body.note || '').trim().slice(0, 1000);
    const updated = await db.query(
      `UPDATE email_change_requests
          SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), review_note = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, student_id, requested_new_email`,
      [id, req.user.studentId, note || null]
    );

    if (!updated.rows[0]) {
      return err(res, 404, 'NOT_FOUND', 'Pending request not found (it may already have been reviewed).');
    }

    await recordAudit('email_change_rejected', {
      studentId: updated.rows[0].student_id,
      ip: req.ip,
      metadata: { requestId: id, note: note.slice(0, 200), reviewedBy: req.user.studentId },
    });

    return res.json({ data: { rejected: true, requestId: id } });
  } catch (error) {
    console.error('reject email change failed:', error);
    return err(res, 500, 'INTERNAL_ERROR', 'Could not reject the request.');
  }
});

module.exports = router;
