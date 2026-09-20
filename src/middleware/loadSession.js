/**
 * Session Loading Middleware
 * Loads authenticated session from cookie and populates req.user
 *
 * IDENTITY MAPPING:
 * sessions.student_id → students.id (VoteWeb student identity)
 *
 * The session's student_id is the authoritative VoteWeb student identity.
 * This eliminates the need for separate lookup tables.
 */

const db = require('../db');
const { hashToken } = require('../lib/crypto');
const { SESSION_COOKIE } = require('../lib/cookies');
const isMongoOnly = !process.env.DATABASE_URL && !!process.env.MONGODB_URI;

/**
 * Timing-safe string comparison
 */
function sameToken(left, right) {
  if (!left || !right) return false;

  const { timingSafeEqual } = require('node:crypto');
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Load session middleware
 * Extracts session from cookie, validates it, and populates req.user
 *
 * Security:
 * - Binding token required for state-changing requests (prevents session fixation)
 * - GET requests load session without binding check
 * - Student identity comes from session.student_id → students.id mapping
 */
async function loadSession(req, res, next) {
  // Parse cookies from raw header if req.cookies is empty
  // (cookie-parser middleware may not populate req.cookies in some cases)
  let sessionId = req.cookies?.[SESSION_COOKIE];

  if (!sessionId && req.headers.cookie) {
    // Parse cookies manually from raw header
    const cookies = {};
    req.headers.cookie.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.split('=');
      if (name && rest.length > 0) {
        cookies[name.trim()] = decodeURIComponent(rest.join('='));
      }
    });
    sessionId = cookies[SESSION_COOKIE];
  }

  // No session cookie - user is not authenticated
  if (!sessionId) {
    return next();
  }

  // Binding token required for state-changing requests
  const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const binding = req.get('X-Session-Binding');

  try {
    // Mongo-only (Atlas M10) — sessions + students in Atlas
    if (isMongoOnly) {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI);
      await client.connect();
      const dbMongo = client.db(process.env.MONGODB_DB || 'voteweb');
      const hashedSession = hashToken(sessionId);
      const sess = await dbMongo.collection('sessions').findOne({ sessionHash: hashedSession, revokedAt: null, expiresAt: { $gt: new Date() } });
      if (!sess) { await client.close(); return next(); }
      if (isStateChanging) {
        if (!binding || !sameToken(sess.bindingHash, hashToken(binding))) { await client.close(); return next(); }
      }
      const st = await dbMongo.collection('students').findOne({ _id: sess.studentId });
      // Fallback to Postgres id as _id or postgresId
      const studentDoc = st || await dbMongo.collection('students').findOne({ postgresId: sess.studentId });
      await client.close();
      if (!studentDoc || !studentDoc.isActive) {
        if (!studentDoc) return next();
        return res.status(403).json({ error: 'Forbidden', message: 'Account is deactivated.', code: 'ACCOUNT_DEACTIVATED' });
      }
      req.user = {
        id: studentDoc._id || studentDoc.postgresId,
        studentId: studentDoc._id || studentDoc.postgresId,
        externalId: studentDoc.externalId,
        userIdentifier: studentDoc.externalId,
        name: studentDoc.name,
        fullName: studentDoc.name,
        email: studentDoc.email,
        rollNumber: studentDoc.rollNumber || null,
        mobileNumber: studentDoc.mobileNumber || null,
        department: studentDoc.department || null,
        year: studentDoc.year || null,
        section: studentDoc.section || null,
        role: studentDoc.role,
        passwordChangeRequired: studentDoc.passwordChangeRequired,
        mfaEnabled: studentDoc.mfaEnabled,
        mfaVerified: sess.mfaVerified,
        sessionId: sess._id,
        sessionCreatedAt: sess.createdAt,
        sessionExpiresAt: sess.expiresAt,
      };
      return next();
    }

    // Find valid session with associated student
    const hashedSession = hashToken(sessionId);

    const result = await db.query(
      `SELECT s.*, st.external_id, st.name, st.email, st.role, st.is_active,
              st.password_change_required, st.mfa_enabled, st.mfa_secret_encrypted,
              st.password_hash, st.roll_number, st.mobile_number, st.department,
              st.year_or_semester, st.section
         FROM sessions s
         JOIN students st ON st.id = s.student_id
        WHERE s.session_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > NOW()`,
      [hashedSession],
    );

    const row = result.rows[0];

    // Session not found or invalid
    if (!row) {
      return next();
    }

    // Validate binding token for state-changing requests (prevents session fixation)
    // The binding token must ALWAYS be present and valid for state-changing requests,
    // otherwise the request is treated as unauthenticated.
    if (isStateChanging) {
      if (!binding || !sameToken(row.binding_hash, hashToken(binding))) {
        return next();
      }
    }

    // Check if student is active
    if (!row.is_active) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Account is deactivated.',
        code: 'ACCOUNT_DEACTIVATED',
      });
    }

    // Populate req.user with authenticated user info
    // CRITICAL: studentId is the VoteWeb students.id - the authoritative identity
    req.user = {
      // Primary VoteWeb identity (students.id)
      id: row.student_id,
      studentId: row.student_id,

      // Auth system identifiers
      externalId: row.external_id,
      userIdentifier: row.external_id,

      // Student info
      name: row.name,
      fullName: row.name,
      email: row.email,
      rollNumber: row.roll_number || null,
      mobileNumber: row.mobile_number || null,
      department: row.department || null,
      year: row.year_or_semester || null,
      section: row.section || null,

      // Role (ADMIN, CANDIDATE, STUDENT)
      role: row.role,

      // Security state
      passwordChangeRequired: row.password_change_required,
      mfaEnabled: row.mfa_enabled,
      mfaVerified: row.mfa_verified,

      // Session info
      sessionId: row.id,
      sessionCreatedAt: row.created_at,
      sessionExpiresAt: row.expires_at,
    };

    // Update last seen (non-blocking)
    db.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [row.id]).catch(() => {});

    return next();
  } catch (error) {
    console.error('Session loading error:', error.message);
    return next();
  }
}

module.exports = { loadSession };
