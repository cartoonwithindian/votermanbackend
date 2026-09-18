/**
 * Admin Whitelist Routes
 * Manage the email whitelist (students table seeded from Excel)
 * Only whitelisted emails can register. Admins can view, search, edit, add, delete.
 * All routes require ADMIN role (mounted behind requireAdmin in app.js).
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { csrfProtection } = require('../middleware/csrfProtection');

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// GET /api/v1/admin/whitelist
// Query: search, department, year_or_semester, section, is_registered (true/false), page, limit
router.get('/', async (req, res) => {
  try {
    const {
      search = '',
      department,
      year_or_semester,
      section,
      is_registered, // 'true' = has password_hash, 'false' = not yet registered
      page = '1',
      limit = '50',
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (search && String(search).trim() !== '') {
      const term = `%${String(search).trim().toLowerCase()}%`;
      conditions.push(`(LOWER(s.name) LIKE $${idx} OR LOWER(s.email) LIKE $${idx} OR LOWER(s.official_email) LIKE $${idx} OR LOWER(s.current_login_email) LIKE $${idx} OR LOWER(s.external_id) LIKE $${idx} OR LOWER(s.student_id) LIKE $${idx})`);
      params.push(term);
      idx++;
    }
    if (department && String(department).trim() !== '') {
      conditions.push(`LOWER(s.department) = LOWER($${idx})`);
      params.push(String(department).trim());
      idx++;
    }
    if (year_or_semester && String(year_or_semester).trim() !== '') {
      conditions.push(`LOWER(s.year_or_semester) = LOWER($${idx})`);
      params.push(String(year_or_semester).trim());
      idx++;
    }
    if (section && String(section).trim() !== '') {
      conditions.push(`LOWER(s.section) = LOWER($${idx})`);
      params.push(String(section).trim());
      idx++;
    }
    if (is_registered === 'true') {
      conditions.push(`s.password_hash IS NOT NULL`);
    } else if (is_registered === 'false') {
      conditions.push(`s.password_hash IS NULL`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await db.query(
      `SELECT COUNT(*)::int as total FROM students s ${whereClause}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    const dataParams = [...params, limitNum, offset];
    const dataQuery = `
      SELECT s.id, s.external_id, s.student_id, s.name, s.email, s.official_email, s.current_login_email,
             s.department, s.year_or_semester, s.section, s.is_active, s.voting_eligible, s.role,
             s.username, s.mobile_number, s.enrollment_number,
             (s.password_hash IS NOT NULL) AS is_registered,
             s.created_at, s.updated_at
        FROM students s
        ${whereClause}
        ORDER BY s.department NULLS LAST, s.year_or_semester, s.section NULLS LAST, s.name
        LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const result = await db.query(dataQuery, dataParams);

    return res.json({
      data: {
        whitelist: result.rows,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    console.error('admin whitelist list failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load whitelist.' } });
  }
});

// GET /api/v1/admin/whitelist/:id
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid id.' } });
    const row = await db.query(
      `SELECT id, external_id, student_id, name, email, official_email, current_login_email,
              department, year_or_semester, section, is_active, voting_eligible, role,
              username, mobile_number, enrollment_number,
              (password_hash IS NOT NULL) AS is_registered, created_at, updated_at
         FROM students WHERE id = $1`,
      [id]
    ).then(r => r.rows[0]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    return res.json({ data: row });
  } catch (error) {
    console.error('admin whitelist get failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not load entry.' } });
  }
});

// POST /api/v1/admin/whitelist - Add new whitelisted email
router.post('/', csrfProtection, async (req, res) => {
  try {
    const { name, email, department, year_or_semester, section } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'Name is required (min 2 chars).' } });
    }
    if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
      return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Valid email is required.' } });
    }
    const normalizedEmail = email.trim().toLowerCase();
    // Check duplicate email (case-insensitive across all email columns)
    const dup = await db.query(
      `SELECT id FROM students
        WHERE LOWER(email) = LOWER($1)
           OR LOWER(official_email) = LOWER($1)
           OR LOWER(current_login_email) = LOWER($1)
        LIMIT 1`,
      [normalizedEmail]
    ).then(r => r.rows[0]);
    if (dup) {
      return res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'Email already whitelisted.' } });
    }

    const dept = department ? String(department).trim().toUpperCase() : null;
    const ysem = year_or_semester ? String(year_or_semester).trim() : null;
    // Section handling: BCOM/MBA/MCA are section-less; for them force NULL
    const sectionLessCourses = new Set(['BCOM', 'MBA', 'MCA']);
    const sec = (dept && sectionLessCourses.has(dept)) ? null : (section ? String(section).trim().toUpperCase() : null);

    // Generate external_id / student_id similar to import: DEPT-SECTION-SEM-NNN
    // Use crypto random to avoid collisions (more robust than COUNT-based).
    const crypto = require('node:crypto');
    const semCode = ysem ? ysem.replace(/\s+/g, '').toUpperCase() : 'MANUAL';
    let prefix;
    if (dept && sec) prefix = `${dept}-${sec}-${semCode}`;
    else if (dept) prefix = `${dept}-${semCode}`;
    else prefix = `WHITELIST`;
    const uniqueSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    // Try count-based sequence + random suffix for human readability + uniqueness
    const seqRow = await db.query(
      `SELECT COUNT(*)::int as cnt FROM students WHERE external_id LIKE $1`,
      [`${prefix}%`]
    ).then(r => r.rows[0]);
    const nextNum = (seqRow?.cnt || 0) + 1;
    const externalId = `${prefix}-${String(nextNum).padStart(3, '0')}-${uniqueSuffix}`;

    const inserted = await db.query(
      `INSERT INTO students (external_id, student_id, name, email, official_email, current_login_email,
                             department, year_or_semester, section, is_active, voting_eligible, role, email_verified)
       VALUES ($1, $1, $2, $3, $3, $3, $4, $5, $6, TRUE, TRUE, 'STUDENT', TRUE)
       RETURNING id, external_id, student_id, name, email, department, year_or_semester, section, is_active, voting_eligible, role`,
      [externalId, name.trim(), normalizedEmail, dept, ysem, sec]
    ).then(r => r.rows[0]);

    // Audit
    const { recordAudit } = require('../lib/authDb');
    await recordAudit('whitelist_added', {
      studentId: req.user?.studentId || null,
      ip: req.ip,
      metadata: { whitelistId: inserted.id, email: normalizedEmail },
    });

    return res.status(201).json({ data: inserted });
  } catch (error) {
    console.error('admin whitelist create failed:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'Email already exists.' } });
    }
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not add whitelist entry.' } });
  }
});

// PATCH /api/v1/admin/whitelist/:id - Edit whitelisted email and details (admin only)
router.patch('/:id', csrfProtection, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid id.' } });

    const existing = await db.query('SELECT * FROM students WHERE id = $1', [id]).then(r => r.rows[0]);
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });

    const { email, name, department, year_or_semester, section, is_active } = req.body || {};

    const sets = [];
    const values = [];
    let vi = 1;

    let normalizedEmail = null;
    if (email !== undefined) {
      if (email === null || String(email).trim() === '') {
        return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Email cannot be empty.' } });
      }
      const trimEmail = String(email).trim().toLowerCase();
      if (!isValidEmail(trimEmail)) {
        return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Valid email required.' } });
      }
      // Check duplicate excluding self
      const dup = await db.query(
        `SELECT id FROM students
          WHERE (LOWER(email)=LOWER($1) OR LOWER(official_email)=LOWER($1) OR LOWER(current_login_email)=LOWER($1))
            AND id != $2
          LIMIT 1`,
        [trimEmail, id]
      ).then(r => r.rows[0]);
      if (dup) {
        return res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'Another record already uses this email.' } });
      }
      normalizedEmail = trimEmail;
      sets.push(`email = $${vi++}`);
      values.push(normalizedEmail);
      // Keep official and current in sync if they were equal to old email
      // Update them to new email as well to keep whitelist consistent
      sets.push(`official_email = $${vi++}`);
      values.push(normalizedEmail);
      sets.push(`current_login_email = $${vi++}`);
      values.push(normalizedEmail);
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length < 2) {
        return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'Name must be at least 2 chars.' } });
      }
      sets.push(`name = $${vi++}`);
      values.push(String(name).trim());
    }
    if (department !== undefined) {
      if (department === null || String(department).trim() === '') {
        sets.push(`department = NULL`);
      } else {
        sets.push(`department = $${vi++}`);
        values.push(String(department).trim().toUpperCase());
      }
    }
    if (year_or_semester !== undefined) {
      if (year_or_semester === null || String(year_or_semester).trim() === '') {
        sets.push(`year_or_semester = NULL`);
      } else {
        const y = String(year_or_semester).trim();
        // Allow any like "1 Sem", "3 Sem", "5 Sem" but normalize
        sets.push(`year_or_semester = $${vi++}`);
        values.push(y);
      }
    }
    if (section !== undefined) {
      if (section === null || String(section).trim() === '') {
        sets.push(`section = NULL`);
      } else {
        const s = String(section).trim().toUpperCase();
        if (s.length > 20) return res.status(400).json({ error: { code: 'INVALID_SECTION', message: 'Section too long.' } });
        sets.push(`section = $${vi++}`);
        values.push(s);
      }
    }
    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') {
        return res.status(400).json({ error: { code: 'INVALID_VALUE', message: 'is_active must be boolean.' } });
      }
      sets.push(`is_active = $${vi++}`);
      values.push(is_active);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: { code: 'NO_CHANGES', message: 'No valid fields to update.' } });
    }

    sets.push(`updated_at = NOW()`);
    values.push(id);

    const updated = await db.query(
      `UPDATE students SET ${sets.join(', ')} WHERE id = $${vi} RETURNING id, external_id, student_id, name, email, official_email, current_login_email, department, year_or_semester, section, is_active, voting_eligible, role, username, (password_hash IS NOT NULL) AS is_registered`,
      values
    ).then(r => r.rows[0]);

    const { recordAudit } = require('../lib/authDb');
    await recordAudit('whitelist_updated', {
      studentId: req.user?.studentId || null,
      ip: req.ip,
      metadata: { whitelistId: id, changes: Object.keys(req.body || {}) },
    });

    return res.json({ data: updated });
  } catch (error) {
    console.error('admin whitelist patch failed:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'Email already exists.' } });
    }
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not update whitelist.' } });
  }
});

// DELETE /api/v1/admin/whitelist/:id - Remove whitelisted entry (hard delete only if not yet registered, otherwise deactivate)
router.delete('/:id', csrfProtection, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid id.' } });
    const row = await db.query('SELECT id, password_hash, email FROM students WHERE id = $1', [id]).then(r => r.rows[0]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });

    if (row.password_hash) {
      // Already registered - do soft delete (deactivate) to preserve audit
      await db.query('UPDATE students SET is_active = FALSE, voting_eligible = FALSE, updated_at = NOW() WHERE id = $1', [id]);
      const { recordAudit } = require('../lib/authDb');
      await recordAudit('whitelist_deactivated', {
        studentId: req.user?.studentId || null,
        ip: req.ip,
        metadata: { whitelistId: id, email: row.email },
      });
      return res.json({ data: { deactivated: true, id } });
    } else {
      await db.query('DELETE FROM students WHERE id = $1', [id]);
      const { recordAudit } = require('../lib/authDb');
      await recordAudit('whitelist_deleted', {
        studentId: req.user?.studentId || null,
        ip: req.ip,
        metadata: { whitelistId: id, email: row.email },
      });
      return res.json({ data: { deleted: true, id } });
    }
  } catch (error) {
    console.error('admin whitelist delete failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not delete.' } });
  }
});

module.exports = router;
