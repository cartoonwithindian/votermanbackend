/**
 * Authentication Database Helper
 * CommonJS implementation based on voteweb-auth/src/db.js
 * Provides database operations specifically for authentication
 */

const db = require('../db');
const config = require('../config');
const { getDb: getSharedDb } = require('../db/mongoClient');

// Mongo-only (Atlas M10): authenticate against the Mongo students collection.
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

/**
 * Record an authentication audit event
 * @param {string} event - Event name
 * @param {object} options - Options
 * @param {number|null} options.studentId - Student ID
 * @param {string|null} options.ip - IP address
 * @param {object} options.metadata - Additional metadata
 */
async function recordAudit(event, { studentId = null, ip = null, metadata = {} } = {}) {
  try {
    await db.query(
      'INSERT INTO auth_audit_logs (student_id, event, ip_address, metadata) VALUES ($1, $2, $3, $4)',
      [studentId, event, ip || null, JSON.stringify(metadata)],
    );
  } catch (error) {
    // Auditing must never turn a successful auth operation into a 500
    console.error('Auth audit log failed:', error.message);
  }
}

/**
 * Find a student by identifier OR email
 * @param {string} identifier - Student identifier or email
 * @returns {Promise<object|null>} - Student record or null
 */
async function findStudentByIdentifierOrEmail(identifier) {
  if (isMongoOnly) {
    try {
      const db = await getSharedDb();
      if (!db) return null;
      const identifierTrim = String(identifier || '').trim();
      const doc = await db.collection('students').findOne({
        $or: [
          { externalId: { $regex: `^${escapeRegex(identifierTrim)}$`, $options: 'i' } },
          { email: { $regex: `^${escapeRegex(identifierTrim)}$`, $options: 'i' } },
          { currentLoginEmail: { $regex: `^${escapeRegex(identifierTrim)}$`, $options: 'i' } },
          { officialEmail: { $regex: `^${escapeRegex(identifierTrim)}$`, $options: 'i' } },
        ],
      });
      return mongoStudentToRow(doc);
    } catch (error) {
      console.error('[authDb] Mongo student lookup failed:', error.message);
      return null;
    }
  }
  const result = await db.query(
    `SELECT id, external_id, name, email, role, password_hash, password_change_required,
            mfa_enabled, mfa_secret_encrypted, failed_login_attempts, locked_until,
            last_login_at, is_active, created_at, updated_at
       FROM students WHERE LOWER(external_id) = LOWER($1) OR LOWER(email) = LOWER($1)
      LIMIT 1`,
    [identifier],
  );
  return result.rows[0] || null;
}

// Escape user input for use inside a MongoDB $regex literal
function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Map a Mongo student doc onto the Postgres row shape the auth routes expect
function mongoStudentToRow(doc) {
  if (!doc) return null;
  return {
    id: doc._id ?? doc.postgresId ?? doc.id,
    external_id: doc.externalId,
    name: doc.name,
    email: doc.email,
    role: doc.role,
    password_hash: doc.passwordHash ?? doc.password_hash ?? null,
    password_change_required: doc.passwordChangeRequired ?? false,
    mfa_enabled: doc.mfaEnabled ?? false,
    mfa_secret_encrypted: doc.mfaSecretEncrypted ?? null,
    failed_login_attempts: doc.failedLoginAttempts ?? 0,
    locked_until: doc.lockedUntil ?? null,
    last_login_at: doc.lastLoginAt ?? null,
    is_active: doc.isActive ?? true,
    created_at: doc.createdAt ?? null,
    updated_at: doc.updatedAt ?? null,
  };
}

/**
 * Increment failed login attempts and potentially lock account
 * @param {object} student - Student record
 * @param {number} maxAttempts - Maximum allowed attempts
 * @param {number} lockoutMs - Lockout duration in milliseconds
 */
async function recordFailedLogin(student, maxAttempts, lockoutMs) {
  const nextAttempts = student.failed_login_attempts + 1;
  const shouldLock = nextAttempts >= maxAttempts;

  await db.query(
    `UPDATE students SET
       failed_login_attempts = $1,
       locked_until = CASE WHEN $2 THEN NOW() + ($3 * INTERVAL '1 millisecond') ELSE locked_until END,
       updated_at = NOW()
     WHERE id = $4`,
    [shouldLock ? 0 : nextAttempts, shouldLock, lockoutMs, student.id],
  );

  return { attempts: nextAttempts, locked: shouldLock };
}

/**
 * Clear failed login attempts and update last login
 * @param {number} studentId - Student ID
 */
async function clearFailedLogin(studentId) {
  await db.query(
    'UPDATE students SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1',
    [studentId],
  );
}

// Wrapper for auth routes compatibility
async function updateStudentLogin(studentId) {
  return clearFailedLogin(studentId);
}

// Wrapper for auth routes compatibility
async function incrementFailedLogin(student) {
  return recordFailedLogin(student, config.maxLoginAttempts, config.lockoutMs);
}

/**
 * Transform a student record for API responses
 * Only includes non-sensitive public fields
 * @param {object} student - Student record from database
 * @returns {object} Public user object
 */
function publicUser(student) {
  if (!student) return null;
  return {
    id: student.id,
    externalId: student.external_id,
    studentId: student.id,
    userIdentifier: student.external_id,
    name: student.name,
    fullName: student.name,
    email: student.email,
    role: student.role,
    passwordChangeRequired: student.password_change_required,
    mfaEnabled: student.mfa_enabled,
  };
}

/**
 * Check if an account is currently locked
 * @param {object} student - Student record
 * @returns {boolean} True if account is locked
 */
function isLocked(student) {
  if (!student || !student.locked_until) return false;
  return new Date(student.locked_until) > new Date();
}

module.exports = {
  recordAudit,
  findStudentByIdentifierOrEmail,
  updateStudentLogin,
  incrementFailedLogin,
  publicUser,
  isLocked,
};