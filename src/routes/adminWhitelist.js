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

// MongoDB-only (Atlas M10) — no Postgres students table; whitelist lives in Postgres
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// GET /api/v1/admin/whitelist
// Query: search, department, year_or_semester, section, is_registered (true/false), page, limit
router.get('/', async (req, res) => {
  // Mongo-only (Atlas M10) — students/whitelist lives in Postgres; return empty gracefully to avoid 500
  if (isMongoOnly) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
      await client.connect();
      const col = client.db(process.env.MONGODB_DB || 'voteweb').collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
      // Attempt to serve whitelist from Mongo students collection (paginated, filtered)
      const {
        search = '',
        department,
        year_or_semester,
        section,
        is_registered,
        page = '1',
        limit = '50',
      } = req.query;
      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
      const filter = {};
      if (search && String(search).trim() !== '') {
        const term = String(search).trim();
        const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [
          { name: regex },
          { email: regex },
          { officialEmail: regex },
          { currentLoginEmail: regex },
          { externalId: regex },
          { studentId: regex },
        ];
      }
      if (department && String(department).trim() !== '') filter.department = String(department).trim().toUpperCase();
      if (year_or_semester && String(year_or_semester).trim() !== '') filter.year = String(year_or_semester).trim();
      if (section && String(section).trim() !== '') filter.section = String(section).trim().toUpperCase();
      if (is_registered === 'true') filter.passwordHash = { $ne: null };
      else if (is_registered === 'false') filter.$or ? filter.passwordHash = null : (filter.passwordHash = null);
      const total = await col.countDocuments(filter);
      const rows = await col.find(filter).sort({ department: 1, year: 1, section: 1, name: 1 }).skip((pageNum - 1) * limitNum).limit(limitNum).toArray();
      await client.close();
      // Map Mongo docs to Postgres-like response shape
      const whitelist = rows.map(r => ({
        id: r._id,
        external_id: r.externalId,
        student_id: r.studentId,
        name: r.name,
        email: r.email,
        official_email: r.officialEmail,
        current_login_email: r.currentLoginEmail,
        department: r.department,
        year_or_semester: r.year,
        section: r.section,
        is_active: r.isActive,
        voting_eligible: r.votingEligible,
        role: r.role,
        username: r.username,
        mobile_number: r.mobileNumber,
        enrollment_number: r.enrollmentNumber,
        is_registered: !!r.passwordHash,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      }));
      return res.json({ data: { whitelist, pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) } } });
    } catch (e) {
      console.error('admin whitelist mongo fallback:', e.message);
      // Mongo not reachable or collection missing — return empty list (never 500)
      const { page = '1', limit = '50' } = req.query;
      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
      return res.json({ data: { whitelist: [], pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 0 } } });
    }
  }
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
  if (isMongoOnly) {
    try {
      const { MongoClient, ObjectId } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
      await client.connect();
      const col = client.db(process.env.MONGODB_DB || 'voteweb').collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
      const rawId = req.params.id;
      let doc = null;
      // Try ObjectId lookup, then _id string, then numeric postgresId
      try { doc = await col.findOne({ _id: new ObjectId(rawId) }); } catch {}
      if (!doc) {
        try { doc = await col.findOne({ _id: rawId }); } catch {}
      }
      if (!doc && !isNaN(parseInt(rawId, 10))) {
        doc = await col.findOne({ postgresId: parseInt(rawId, 10) });
      }
      await client.close();
      if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      const mapped = {
        id: doc._id,
        external_id: doc.externalId,
        student_id: doc.studentId,
        name: doc.name,
        email: doc.email,
        official_email: doc.officialEmail,
        current_login_email: doc.currentLoginEmail,
        department: doc.department,
        year_or_semester: doc.year,
        section: doc.section,
        is_active: doc.isActive,
        voting_eligible: doc.votingEligible,
        role: doc.role,
        username: doc.username,
        mobile_number: doc.mobileNumber,
        enrollment_number: doc.enrollmentNumber,
        is_registered: !!doc.passwordHash,
        created_at: doc.createdAt,
        updated_at: doc.updatedAt,
      };
      return res.json({ data: mapped });
    } catch (e) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    }
  }
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
  if (isMongoOnly) {
    try {
      const { name, email, department, year_or_semester, section } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'Name is required (min 2 chars).' } });
      }
      if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
        return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Valid email is required.' } });
      }
      const normalizedEmail = email.trim().toLowerCase();
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
      await client.connect();
      const col = client.db(process.env.MONGODB_DB || 'voteweb').collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
      const dup = await col.findOne({ $or: [{ email: normalizedEmail }, { officialEmail: normalizedEmail }, { currentLoginEmail: normalizedEmail }] });
      if (dup) {
        await client.close();
        return res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'Email already whitelisted.' } });
      }
      const dept = department ? String(department).trim().toUpperCase() : null;
      const ysem = year_or_semester ? String(year_or_semester).trim() : null;
      const sectionLessCourses = new Set(['BCOM', 'MBA', 'MCA']);
      const sec = (dept && sectionLessCourses.has(dept)) ? null : (section ? String(section).trim().toUpperCase() : null);
      const crypto = require('node:crypto');
      const semCode = ysem ? ysem.replace(/\s+/g, '').toUpperCase() : 'MANUAL';
      let prefix;
      if (dept && sec) prefix = `${dept}-${sec}-${semCode}`;
      else if (dept) prefix = `${dept}-${semCode}`;
      else prefix = `WHITELIST`;
      const uniqueSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
      const count = await col.countDocuments({ externalId: { $regex: `^${prefix}` } });
      const externalId = `${prefix}-${String(count + 1).padStart(3, '0')}-${uniqueSuffix}`;
      const now = new Date();
      const doc = {
        externalId,
        studentId: externalId,
        name: name.trim(),
        email: normalizedEmail,
        officialEmail: normalizedEmail,
        currentLoginEmail: normalizedEmail,
        department: dept,
        year: ysem,
        section: sec,
        isActive: true,
        votingEligible: true,
        role: 'STUDENT',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      };
      const inserted = await col.insertOne(doc);
      await client.close();
      return res.status(201).json({ data: { id: inserted.insertedId, external_id: externalId, student_id: externalId, name: doc.name, email: doc.email, department: dept, year_or_semester: ysem, section: sec, is_active: true, voting_eligible: true, role: 'STUDENT' } });
    } catch (e) {
      console.error('admin whitelist create failed (mongo):', e);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not add whitelist entry.' } });
    }
  }
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
  if (isMongoOnly) {
    try {
      const { MongoClient, ObjectId } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
      await client.connect();
      const col = client.db(process.env.MONGODB_DB || 'voteweb').collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
      const rawId = req.params.id;
      let existing = null;
      try { existing = await col.findOne({ _id: new ObjectId(rawId) }); } catch {}
      if (!existing) {
        try { existing = await col.findOne({ _id: rawId }); } catch {}
      }
      if (!existing && !isNaN(parseInt(rawId, 10))) existing = await col.findOne({ postgresId: parseInt(rawId, 10) });
      if (!existing) { await client.close(); return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }); }
      const { email, name, department, year_or_semester, section, is_active } = req.body || {};
      const update = {};
      if (email !== undefined) {
        if (email === null || String(email).trim() === '') { await client.close(); return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Email cannot be empty.' } }); }
        const trimEmail = String(email).trim().toLowerCase();
        if (!isValidEmail(trimEmail)) { await client.close(); return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Valid email required.' } }); }
        const dup = await col.findOne({ _id: { $ne: existing._id }, $or: [{ email: trimEmail }, { officialEmail: trimEmail }, { currentLoginEmail: trimEmail }] });
        if (dup) { await client.close(); return res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'Another record already uses this email.' } }); }
        update.email = trimEmail; update.officialEmail = trimEmail; update.currentLoginEmail = trimEmail;
      }
      if (name !== undefined) {
        if (typeof name !== 'string' || name.trim().length < 2) { await client.close(); return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'Name must be at least 2 chars.' } }); }
        update.name = String(name).trim();
      }
      if (department !== undefined) update.department = department === null || String(department).trim() === '' ? null : String(department).trim().toUpperCase();
      if (year_or_semester !== undefined) update.year = year_or_semester === null || String(year_or_semester).trim() === '' ? null : String(year_or_semester).trim();
      if (section !== undefined) {
        if (section === null || String(section).trim() === '') update.section = null;
        else {
          const s = String(section).trim().toUpperCase();
          if (s.length > 20) { await client.close(); return res.status(400).json({ error: { code: 'INVALID_SECTION', message: 'Section too long.' } }); }
          update.section = s;
        }
      }
      if (is_active !== undefined) {
        if (typeof is_active !== 'boolean') { await client.close(); return res.status(400).json({ error: { code: 'INVALID_VALUE', message: 'is_active must be boolean.' } }); }
        update.isActive = is_active;
      }
      if (Object.keys(update).length === 0) { await client.close(); return res.status(400).json({ error: { code: 'NO_CHANGES', message: 'No valid fields to update.' } }); }
      update.updatedAt = new Date();
      await col.updateOne({ _id: existing._id }, { $set: update });
      const updatedDoc = await col.findOne({ _id: existing._id });
      await client.close();
      return res.json({ data: {
        id: updatedDoc._id,
        external_id: updatedDoc.externalId,
        student_id: updatedDoc.studentId,
        name: updatedDoc.name,
        email: updatedDoc.email,
        official_email: updatedDoc.officialEmail,
        current_login_email: updatedDoc.currentLoginEmail,
        department: updatedDoc.department,
        year_or_semester: updatedDoc.year,
        section: updatedDoc.section,
        is_active: updatedDoc.isActive,
        voting_eligible: updatedDoc.votingEligible,
        role: updatedDoc.role,
        username: updatedDoc.username,
        is_registered: !!updatedDoc.passwordHash,
      }});
    } catch (e) {
      console.error('admin whitelist patch failed (mongo):', e);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not update whitelist.' } });
    }
  }
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
  if (isMongoOnly) {
    try {
      const { MongoClient, ObjectId } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
      await client.connect();
      const col = client.db(process.env.MONGODB_DB || 'voteweb').collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students');
      const rawId = req.params.id;
      let row = null;
      try { row = await col.findOne({ _id: new ObjectId(rawId) }); } catch {}
      if (!row) {
        try { row = await col.findOne({ _id: rawId }); } catch {}
      }
      if (!row && !isNaN(parseInt(rawId, 10))) row = await col.findOne({ postgresId: parseInt(rawId, 10) });
      if (!row) { await client.close(); return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }); }
      if (row.passwordHash) {
        await col.updateOne({ _id: row._id }, { $set: { isActive: false, votingEligible: false, updatedAt: new Date() } });
        await client.close();
        return res.json({ data: { deactivated: true, id: rawId } });
      } else {
        await col.deleteOne({ _id: row._id });
        await client.close();
        return res.json({ data: { deleted: true, id: rawId } });
      }
    } catch (e) {
      console.error('admin whitelist delete failed (mongo):', e);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Could not delete.' } });
    }
  }
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
