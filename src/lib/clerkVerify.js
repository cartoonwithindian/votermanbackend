/**
 * Verify a Clerk session token (JWT) issued to a signed-in user.
 *
 * Used by the registration, forgot-password and clerk-session endpoints: the
 * frontend proves email ownership by completing a Clerk email-code challenge,
 * then sends the Clerk session token as a Bearer token. We verify the token
 * with the official @clerk/express middleware (clerkMiddleware() + getAuth())
 * and resolve the primary email server-side (via the Clerk Backend API when
 * CLERK_SECRET_KEY is configured).
 *
 * Throws an Error with .code and .status on failure.
 */

const { clerkMiddleware, getAuth } = require('@clerk/express');

// Express middleware that requires the Clerk env keys before enabling the
// official token verification. In local mode without keys it returns a clear
// 501 so callers know Clerk is disabled locally (no remote API key required).
function requireClerkMiddleware(req, res, next) {
  const hasKeys = process.env.CLERK_SECRET_KEY || process.env.CLERK_PUBLISHABLE_KEY;
  if (!hasKeys) {
    console.warn('clerkVerify: CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY not configured — Clerk disabled in local mode');
    return res.status(501).json({
      error: { code: 'CLERK_NOT_CONFIGURED', message: 'Clerk disabled in local mode — set CLERK_SECRET_KEY to enable.' },
    });
  }
  // Safe debug logging: only header presence + token length. The token value
  // itself is NEVER logged.
  const header = req.headers.authorization;
  const isBearer = typeof header === 'string' && /^Bearer\s+/i.test(header);
  const raw = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
  const hasAuthHeader = Boolean(header);
  console.log(`[CLERK DEBUG] authorization present: ${hasAuthHeader}`);
  console.log(`[CLERK DEBUG] bearer token length: ${isBearer ? raw.length : 0}`);
  return clerkMiddleware()(req, res, next);
}

/** Log the @clerk/express verification outcome (userId present = verified). */
function logVerificationResult(req, label) {
  const auth = getAuth(req);
  const userId = auth && auth.userId ? auth.userId : null;
  console.log(`[CLERK DEBUG]${label ? ` ${label}` : ''} verification result: ${userId ? 'valid' : 'invalid'}`);
  return auth;
}

// ---- Look up the Clerk user's primary email via the Backend API ----
async function fetchClerkPrimaryEmail(secretKey, clerkUserId) {
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  const primaryId = user.primary_email_address_id;
  const primary = (user.email_addresses || []).find((e) => e.id === primaryId);
  return primary && primary.verification && primary.verification.status === 'verified'
    ? primary.email_address.toLowerCase()
    : primary
      ? primary.email_address.toLowerCase()
      : null;
}

/**
 * Verify the Clerk session token on a request (must run after
 * requireClerkMiddleware) and resolve the user's email server-side.
 * @param {import('express').Request} req
 * @returns {Promise<{clerkUserId: string, email: string}>}
 */
async function verifyClerkSessionRequest(req) {
  const auth = logVerificationResult(req, 'verifyClerkSessionRequest');
  const clerkUserId = auth && auth.userId ? auth.userId : null;
  if (!clerkUserId) {
    const err = new Error('Sign-in token is invalid or expired. Please sign in again.');
    err.code = 'INVALID_CLERK_TOKEN';
    err.status = 401;
    throw err;
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  // CRITICAL: the resolved email is used to find the account (register /
  // password reset). It MUST come from the Clerk Backend API, not the client,
  // or the "email" is attacker-controlled → account takeover. Fail closed when
  // CLERK_SECRET_KEY is absent rather than trusting clientEmail.
  const serverEmail = secretKey ? await fetchClerkPrimaryEmail(secretKey, clerkUserId) : null;
  if (!serverEmail) {
    const err = new Error('Could not verify your email. Please ensure the Clerk backend is configured.');
    err.code = 'CLERK_EMAIL_UNVERIFIED';
    err.status = 401;
    throw err;
  }
  const email = serverEmail;
  if (!email || !email.includes('@')) {
    const err = new Error('The verified account has no usable email address.');
    err.code = 'NO_EMAIL';
    err.status = 400;
    throw err;
  }

  return { clerkUserId, email };
}

module.exports = { verifyClerkSessionRequest, requireClerkMiddleware, fetchClerkPrimaryEmail, logVerificationResult };
