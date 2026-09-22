/**
 * Session Service
 * Manages user sessions
 */

const { randomBytes } = require('node:crypto');
const db = require('../db');
const { hashToken } = require('../lib/crypto');
const { setSessionCookie, clearSessionCookie, SESSION_COOKIE } = require('../lib/cookies');
const config = require('../config');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getClient: getSharedClient } = require('../db/mongoClient');

// Mongo-only (Atlas M10) in-memory session store when Postgres is disabled
const isMongoOnly = !process.env.DATABASE_URL && !!process.env.MONGODB_URI;
const memorySessions = new Map(); // sessionHash -> { studentId, bindingHash, mfaVerified, expiresAt }

/**
 * Create a new session for a student
 * @param {object} res - Express response object
 * @param {number} studentId - Student ID
 * @param {boolean} mfaVerified - Whether MFA has been verified
 * @returns {Promise<string>} - Binding token
 */
async function createSession(res, studentId, mfaVerified = false) {
  const sessionToken = randomBytes(32).toString('base64url');
  const bindingToken = randomBytes(32).toString('base64url');

  if (isMongoOnly) {
    // In-memory for Atlas M10 (single instance free tier)
    const expiresAt = Date.now() + config.sessionTtlMs;
    memorySessions.set(hashToken(sessionToken), { studentId, bindingHash: hashToken(bindingToken), mfaVerified, expiresAt });
    // Also try Mongo Atlas if available (persistent)
    try {
      const client = await getSharedClient();
      await client.db(getMongoDbName()).collection('sessions').insertOne({
        sessionHash: hashToken(sessionToken),
        bindingHash: hashToken(bindingToken),
        studentId,
        mfaVerified,
        expiresAt: new Date(expiresAt),
        createdAt: new Date(),
      });
    } catch {}
    setSessionCookie(res, sessionToken);
    return bindingToken;
  }

  // A browser has one CampusVote session cookie. Revoke any previous session
  // before issuing a new one so switching accounts cannot reuse the old user.
  const previousSessionToken = res.req?.cookies?.[SESSION_COOKIE];
  if (previousSessionToken) {
    await db.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE session_hash = $1 AND revoked_at IS NULL',
      [hashToken(previousSessionToken)],
    );
  }

  await db.query(
    `INSERT INTO sessions (session_hash, binding_hash, student_id, mfa_verified, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 millisecond'))`,
    [hashToken(sessionToken), hashToken(bindingToken), studentId, mfaVerified, config.sessionTtlMs],
  );

  setSessionCookie(res, sessionToken);
  return bindingToken;
}

/**
 * Revoke a session
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
async function revokeSession(req, res) {
  const sessionId = req.cookies?.[SESSION_COOKIE];

  if (sessionId) {
    await db.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE session_hash = $1 AND revoked_at IS NULL',
      [hashToken(sessionId)],
    );
  }

  clearSessionCookie(res);
}

/**
 * Rotate session (revoke old, create new)
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {number} studentId - Student ID
 * @param {boolean} mfaVerified - Whether MFA has been verified
 * @returns {Promise<string>} - New binding token
 */
async function rotateSession(req, res, studentId, mfaVerified = false) {
  await revokeSession(req, res);
  return createSession(res, studentId, mfaVerified);
}

module.exports = {
  createSession,
  revokeSession,
  rotateSession,
};
