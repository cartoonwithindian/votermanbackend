/**
 * Clerk → Backend Session Bridge
 *
 * After a user signs in with Google via Clerk (frontend), the client calls
 * POST /api/v1/auth/clerk-session with the Clerk session token (Bearer).
 * We verify the token against the Clerk dev-instance JWKS, look up the
 * account by verified email, then create a regular backend session
 * (cv_sid cookie + binding token) so all /api/v1 routes work unchanged.
 *
 * Requires env vars:
 *   CLERK_ISSUER     e.g. https://closing-hawk-9939.clerk.accounts.dev
 *   CLERK_SECRET_KEY backend secret key (sk_...) for email cross-check
 */

const express = require('express');
const { randomBytes } = require('node:crypto');
const router = express.Router();

const db = require('../db');
const { csrfProtection } = require('../middleware/csrfProtection');
const { loginLimiter } = require('../middleware/rateLimiter');
const { hashPassword } = require('../lib/password');
const { createSession } = require('../services/sessionService');
const { recordAudit, publicUser } = require('../lib/authDb');
const { requireClerkMiddleware, fetchClerkPrimaryEmail, logVerificationResult } = require('../lib/clerkVerify');
const { getMongoDbName } = require('../utils/mongoDbName');
const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

function authError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

router.post('/clerk-session', loginLimiter, csrfProtection, requireClerkMiddleware, async (req, res) => {
  try {
    // ---- 1. Verify the Clerk session token (official @clerk/express) ----
    const auth = logVerificationResult(req, 'clerk-session');
    const clerkUserId = auth && auth.userId ? auth.userId : null;
    if (!clerkUserId) {
      return authError(res, 401, 'INVALID_CLERK_TOKEN', 'Clerk session token is invalid or expired.');
    }

    // ---- 2. Resolve email: MUST be the Clerk primary email when the backend
    // secret key is configured. If CLERK_SECRET_KEY is missing, we refuse to
    // trust the client-supplied email (otherwise the "email" the account is
    // looked up by is attacker-controlled → account takeover). This makes the
    // bridge fail closed in production rather than silently trusting the client.
    const secretKey = process.env.CLERK_SECRET_KEY;
    const primaryEmail = secretKey
      ? await fetchClerkPrimaryEmail(secretKey, clerkUserId)
      : null;
    if (!primaryEmail) {
      // No server-derived email => do NOT fall back to the client's claim.
      return authError(res, 401, 'CLERK_EMAIL_UNVERIFIED', 'Could not verify your Google email. Please ensure Clerk is configured and your email is verified.');
    }
    const email = primaryEmail;
    const requestedRoleRaw = String(req.body.role || '').toUpperCase().trim();
    if (!email || !email.includes('@')) {
      return authError(res, 400, 'NO_EMAIL', 'Google account has no verified email address.');
    }

    // ---- 3.5 Role bootstrap lists ----
    // Open registration: any Google account may sign in and is provisioned
    // as STUDENT (CANDIDATE is earned on application approval).
    const adminList = String(process.env.ADMIN_EMAILS || '')
      .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    const cadList = String(process.env.CAD_EMAILS || '')
      .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

    // ---- 4. Find the account (or auto-provision) ----
    // Identity is tied to student_id; the login email is a changeable
    // credential. Priority: current_login_email > legacy email > official_email.
    let account = null;
    if (isMongoOnly) {
      const { MongoClient } = require('mongodb');
      const mclient = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
      await mclient.connect();
      const mdb = mclient.db(getMongoDbName());
      account = await mdb.collection('students').findOne({
        isActive: true,
        $or: [
          { email: { $regex: `^${email}$`, $options: 'i' } },
          { currentLoginEmail: { $regex: `^${email}$`, $options: 'i' } },
          { officialEmail: { $regex: `^${email}$`, $options: 'i' } },
        ],
      });
      // Map Mongo doc to Postgres-like shape for publicUser
      if (account) {
        account = {
          id: account._id || account.postgresId,
          external_id: account.externalId,
          name: account.name,
          email: account.email,
          role: account.role,
          is_active: account.isActive,
          password_change_required: account.passwordChangeRequired,
          mfa_enabled: account.mfaEnabled,
        };
      }
      await mclient.close();
    } else {
      account = await db.query(
        `SELECT * FROM students
          WHERE is_active = TRUE
            AND (LOWER(current_login_email) = LOWER($1)
              OR LOWER(email) = LOWER($1)
              OR LOWER(official_email) = LOWER($1))
          ORDER BY CASE
            WHEN LOWER(current_login_email) = LOWER($1) THEN 0
            WHEN LOWER(email) = LOWER($1) THEN 1
            ELSE 2 END
          LIMIT 1`,
        [email]
      ).then((r) => r.rows[0]);
    }

    if (!account) {
      // ---- WHITELIST ENFORCEMENT for Google ----
      // Only whitelisted emails (or invited admins/CAD) may continue with Google.
      // Others get a clear error to contact support team.
      let whitelistCheck = null;
      if (isMongoOnly) {
        const { MongoClient } = require('mongodb');
        const mclient = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
        await mclient.connect();
        const mdb = mclient.db(getMongoDbName());
        whitelistCheck = await mdb.collection('students').findOne({
          $or: [
            { email: { $regex: `^${email}$`, $options: 'i' } },
            { officialEmail: { $regex: `^${email}$`, $options: 'i' } },
            { currentLoginEmail: { $regex: `^${email}$`, $options: 'i' } },
          ],
        });
        if (whitelistCheck) {
          whitelistCheck = { id: whitelistCheck._id || whitelistCheck.postgresId, is_active: whitelistCheck.isActive };
        }
        await mclient.close();
      } else {
        whitelistCheck = await db.query(
          `SELECT id, is_active FROM students
             WHERE LOWER(email) = LOWER($1)
                OR LOWER(official_email) = LOWER($1)
                OR LOWER(current_login_email) = LOWER($1)
             LIMIT 1`,
          [email.toLowerCase()]
        ).then(r => r.rows[0]);
      }
      const isWhitelisted = !!whitelistCheck;
      const isInvitedAdmin = adminList.includes(email.toLowerCase());
      const isCadInvited = cadList.map(e => e.toLowerCase()).includes(email.toLowerCase());
      if (!isWhitelisted && !isInvitedAdmin && !isCadInvited) {
        await recordAudit('clerk_login_denied_not_whitelisted', {
          ip: req.ip,
          metadata: { email, clerkUserId },
        });
        return authError(res, 403, 'NOT_WHITELISTED', 'This Google account is not whitelisted. Only whitelisted students can login or register. Please contact the support team.');
      }
      if (whitelistCheck && !whitelistCheck.is_active) {
        return authError(res, 403, 'ACCOUNT_DEACTIVATED', 'This whitelisted account has been deactivated. Please contact the support team.');
      }
      if (whitelistCheck) {
        let pending = null;
        if (isMongoOnly) {
          const { MongoClient } = require('mongodb');
          const mclient = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
          await mclient.connect();
          const mdb = mclient.db(getMongoDbName());
          pending = await mdb.collection('students').findOne({ _id: whitelistCheck.id }) || await mdb.collection('students').findOne({ postgresId: whitelistCheck.id });
          if (pending) {
            pending = { id: pending._id || pending.postgresId, external_id: pending.externalId, name: pending.name, email: pending.email, role: pending.role, is_active: pending.isActive };
          }
          await mclient.close();
        } else {
          pending = await db.query(
            `SELECT * FROM students WHERE id = $1`,
            [whitelistCheck.id]
          ).then(r => r.rows[0]);
        }
        if (pending) {
          account = pending;
          console.log('clerk-session: using pending whitelist row', { email });
        }
      }
      if (!account) {
      // ---- Auto-provision every new Google account as STUDENT ----
      const name = String(req.body.name || '').trim() || email.split('@')[0];
      const usernameBase = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase() || 'user';
      const username = `${usernameBase}.${randomBytes(3).toString('hex')}`;
      const randomPassword = randomBytes(24).toString('base64url');
      const passwordHash = await hashPassword(randomPassword);
      const externalId = `CLERK-${clerkUserId}`;

      // Invited admins are created straight as ADMIN.
      // CAD is gated: when CAD_EMAILS is set, only listed emails become CAD;
      // when it is unset, the CAD portal is open to any non-admin (documented,
      // allow-list behavior). CANDIDATE is NEVER granted at signup — it is
      // earned when an admin approves the candidate application.
      const isCadAllowed = cadList.length > 0
        ? cadList.includes(email)
        : requestedRoleRaw === 'CAD';
      const roleToUse = isInvitedAdmin
        ? 'ADMIN'
        : isCadAllowed
          ? 'CAD'
          : 'STUDENT';

      let inserted = null;
      if (isMongoOnly) {
        const { MongoClient } = require('mongodb');
        const mclient = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
        await mclient.connect();
        const mdb = mclient.db(getMongoDbName());
        const newId = Date.now();
        const doc = {
          _id: newId,
          postgresId: newId,
          externalId,
          name,
          email,
          passwordHash,
          role: roleToUse,
          isActive: true,
          username,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await mdb.collection('students').insertOne(doc);
        await mclient.close();
        inserted = { id: doc._id, external_id: doc.externalId, name: doc.name, email: doc.email, role: doc.role, is_active: true };
      } else {
        inserted = await db.query(
          `INSERT INTO students (external_id, name, email, password_hash, role, is_active, username)
           VALUES ($1, $2, $3, $4, $5, TRUE, $6)
           RETURNING *`,
          [externalId, name, email, passwordHash, roleToUse, username]
        ).then((r) => r.rows[0]);
      }
      account = inserted;
      console.log('clerk-session: provisioned invited account', { email, role: roleToUse });
      }
    } else if (adminList.includes(email) && account.role !== 'ADMIN') {
      // Bootstrap: promote listed emails to ADMIN on sign-in.
      // Checked FIRST: ADMIN always wins when an email is on both lists.
      if (isMongoOnly) {
        const { MongoClient } = require('mongodb');
        const mclient = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
        await mclient.connect();
        const mdb = mclient.db(getMongoDbName());
        await mdb.collection('students').updateOne({ _id: account.id }, { $set: { role: 'ADMIN' } });
        await mclient.close();
        account.role = 'ADMIN';
      } else {
        const promoted = await db.query(
          `UPDATE students SET role = 'ADMIN' WHERE id = $1 RETURNING role`,
          [account.id]
        ).then((r) => r.rows[0]);
        account.role = promoted.role;
      }
      console.log('clerk-session: bootstrapped admin', { email });
    } else if (requestedRoleRaw === 'CAD' && account.role !== 'CAD' && account.role !== 'ADMIN') {
      // CAD portal: when CAD_EMAILS is set, only listed emails are promoted;
      // otherwise open (documented, allow-list behavior). ADMIN never demoted.
      const isCadAllowed = cadList.length > 0 ? cadList.includes(email) : true;
      if (isCadAllowed) {
        if (isMongoOnly) {
          const { MongoClient } = require('mongodb');
          const mclient = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
          await mclient.connect();
          const mdb = mclient.db(getMongoDbName());
          await mdb.collection('students').updateOne({ _id: account.id }, { $set: { role: 'CAD' } });
          await mclient.close();
          account.role = 'CAD';
        } else {
          const promoted = await db.query(
            `UPDATE students SET role = 'CAD' WHERE id = $1 RETURNING role`,
            [account.id]
          ).then((r) => r.rows[0]);
          account.role = promoted.role;
        }
        console.log('clerk-session: granted CAD', { email });
      }
    }

    // ---- 5. Create backend session (cv_sid cookie set here) ----
    const bindingToken = await createSession(res, account.id, false);

    await recordAudit('clerk_google_login', {
      studentId: account.id,
      ip: req.ip,
      metadata: { role: account.role, clerkUserId },
    });

    return res.json({
      data: {
        authenticated: true,
        bindingToken,
        user: publicUser(account),
      },
    });
  } catch (error) {
    console.error('clerk-session error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred during sign-in.');
  }
});

module.exports = router;
