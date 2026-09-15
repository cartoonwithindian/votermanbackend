/**
 * Authentication Routes
 * Handles login, logout, MFA, OTP, and password management
 * Supports role-aware authentication for STUDENT, CANDIDATE, and ADMIN
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { loadSession } = require('../middleware/loadSession');
const { requireAuth } = require('../middleware/requireAuth');
const { csrfProtection } = require('../middleware/csrfProtection');
const { loginLimiter, mfaLimiter, registerLimiter, otpLimiter, passwordResetLimiter } = require('../middleware/rateLimiter');
const { hashPassword, verifyPassword, validatePasswordPolicy } = require('../lib/password');
const { verifyTotp, generateTotpSecret, provisioningUri } = require('../lib/totp');
const { encryptSecret, decryptSecret, hashToken } = require('../lib/crypto');
const { mintCsrfToken, CSRF_COOKIE } = require('../lib/cookies');
const { createSession, revokeSession, rotateSession } = require('../services/sessionService');
const { createMfaChallenge, findChallenge, deleteChallenge, incrementChallengeAttempts } = require('../services/mfaService');
const { createOtpChallenge, findValidChallenge, verifyOtpChallenge, checkRateLimit, RESEND_COOLDOWN_MS } = require('../services/otpService');
const { sendLoginOtp, sendPasswordResetOtp } = require('../services/brevoService');
const { recordAudit, findStudentByIdentifierOrEmail, publicUser, isLocked, incrementFailedLogin, updateStudentLogin } = require('../lib/authDb');
const { verifyClerkSessionRequest, requireClerkMiddleware } = require('../lib/clerkVerify');
const { incLoginAttempt, incFailedLogin } = require('../monitoring/metrics');

// Helper for consistent error responses
function authError(res, status, code, message) {
  return res.status(status).json({
    error: { code, message },
  });
}

// =====================================================
// CSRF TOKEN
// =====================================================
router.get('/csrf', (req, res) => {
  const csrfToken = mintCsrfToken(res);
  return res.json({
    data: { csrfToken },
  });
});

// =====================================================
// DEBUG: Check Brevo email status (booleans only — never expose the API key
// prefix or sender address to unauthenticated callers).
// =====================================================
router.get('/debug/brevo-status', (req, res) => {
  res.json({
    configured: !!process.env.BREVO_API_KEY,
  });
});

// =====================================================
// CURRENT USER
// =====================================================
router.get('/me', loadSession, (req, res) => {
  if (!req.user || !req.user.studentId) {
    return res.json({ data: { authenticated: false } });
  }
  return res.json({
    data: {
      authenticated: true,
      user: req.user,
    },
  });
});

// =====================================================
// COMPLETE PROFILE (first-time registration step)
// One-time capture of roll number + course + year + section.
// The account is created bare by the Clerk bridge; dashboards require
// these fields before the student can vote or apply as a candidate.
// =====================================================
const PROFILE_COURSES = ['BBA', 'BCA', 'BCOM', 'MBA', 'MCA'];
const PROFILE_YEARS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];

router.post('/profile', loadSession, requireAuth, csrfProtection, async (req, res) => {
  try {
    const { rollNumber, department, year, section } = req.body;

    const account = await db.query(
      'SELECT id, roll_number FROM students WHERE id = $1',
      [req.user.studentId]
    ).then((r) => r.rows[0]);

    if (!account) {
      return authError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    }

    // One-time step: once a roll number is stored the profile is locked.
    // Corrections go through the administrator / support flow.
    if (account.roll_number) {
      return authError(res, 403, 'PROFILE_LOCKED', 'Your profile is already completed. Contact the administrator to change it.');
    }

    const roll = String(rollNumber || '').trim();
    if (roll.length < 3 || roll.length > 64) {
      return authError(res, 400, 'INVALID_ROLL', 'Please enter a valid roll / enrollment number (3-64 characters).');
    }

    const course = String(department || '').trim().toUpperCase();
    if (!PROFILE_COURSES.includes(course)) {
      return authError(res, 400, 'INVALID_COURSE', `Course must be one of: ${PROFILE_COURSES.join(', ')}.`);
    }

    const yearValue = String(year || '').trim();
    if (!PROFILE_YEARS.includes(yearValue)) {
      return authError(res, 400, 'INVALID_YEAR', `Year must be one of: ${PROFILE_YEARS.join(', ')}.`);
    }

    const sectionValue = String(section || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(sectionValue)) {
      return authError(res, 400, 'INVALID_SECTION', 'Please enter a valid section (letters/numbers, up to 10 characters).');
    }

    // Roll number IS the student identity — must be unique.
    const dupRoll = await db.query(
      'SELECT id FROM students WHERE LOWER(roll_number) = LOWER($1) AND id != $2 LIMIT 1',
      [roll, req.user.studentId]
    ).then((r) => r.rows[0]);
    if (dupRoll) {
      return authError(res, 409, 'ROLL_EXISTS', 'This roll number is already registered. If it is yours, sign in with that account or contact the administrator.');
    }

    const updated = await db.query(
      `UPDATE students
          SET roll_number = $1, department = $2, year_or_semester = $3, section = $4,
              updated_at = NOW()
        WHERE id = $5
        RETURNING roll_number, department, year_or_semester, section`,
      [roll, course, yearValue, sectionValue, req.user.studentId]
    ).then((r) => r.rows[0]);

    await recordAudit('profile_completed', {
      studentId: req.user.studentId,
      ip: req.ip,
      metadata: { department: course, year: yearValue, section: sectionValue },
    });

    return res.json({
      data: {
        message: 'Profile completed successfully.',
        profile: {
          rollNumber: updated.roll_number,
          department: updated.department,
          year: updated.year_or_semester,
          section: updated.section,
        },
      },
    });
  } catch (error) {
    console.error('Complete profile error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// LOGIN - Role-aware authentication
// =====================================================
router.post('/login', loginLimiter, csrfProtection, async (req, res) => {
  try {
    incLoginAttempt();
    const { userIdentifier, password, role } = req.body;

    // Validate input
    if (!userIdentifier || typeof userIdentifier !== 'string' || userIdentifier.trim().length < 3) {
      return authError(res, 400, 'INVALID_INPUT', 'Username or email is required (min 3 characters).');
    }

    if (!password || typeof password !== 'string' || password.length < 1) {
      return authError(res, 400, 'INVALID_INPUT', 'Password is required.');
    }

    // ---- Demo accounts (student / candidate portals) ----
    // Auto-provisions student@gmail.com (STUDENT) and candidate@gmail.com
    // (CANDIDATE) with password 1234 on first login, so both portals can be
    // demoed instantly. Real accounts are unaffected.
    const demoEmail = String(userIdentifier || '').trim().toLowerCase();
    const DEMO_ACCOUNTS = {
      'student@gmail.com': { role: 'STUDENT', name: 'Demo Student', externalId: 'STU-DEMO' },
      'candidate@gmail.com': { role: 'CANDIDATE', name: 'Demo Candidate', externalId: 'CAND-DEMO' },
    };
    if (DEMO_ACCOUNTS[demoEmail] && password === '1234') {
      try {
        const demo = DEMO_ACCOUNTS[demoEmail];
        const demoHash = await hashPassword('1234');
        const existingDemo = await db.query(
          'SELECT id FROM students WHERE LOWER(email) = $1 LIMIT 1',
          [demoEmail]
        ).then(r => r.rows[0]);
        if (!existingDemo) {
          await db.query(
            `INSERT INTO students (external_id, name, email, password_hash, role, is_active, username,
                                   password_change_required, roll_number, department, year_or_semester, section)
             VALUES ($1, $2, $3, $4, $5, TRUE, $6, FALSE, $7, $8, $9, $10)
             ON CONFLICT DO NOTHING`,
            [demo.externalId, demo.name, demoEmail, demoHash, demo.role,
             demoEmail.split('@')[0], 'DEMO-001', 'BCA', '2nd Year', 'A']
          );
        } else {
          // Keep the demo credentials usable even if the row pre-existed.
          await db.query(
            `UPDATE students
                SET password_hash = $1, role = $2, is_active = TRUE,
                    password_change_required = FALSE, locked_until = NULL,
                    failed_login_attempts = 0,
                    roll_number = COALESCE(roll_number, $3)
              WHERE LOWER(email) = $4`,
            [demoHash, demo.role, 'DEMO-001', demoEmail]
          );
        }
      } catch (demoErr) {
        console.error('Demo account provision error:', demoErr.message);
      }
    }

    // Validate role. When omitted, the account's actual DB role is used
    // (the main portal lets any role sign in; dashboards route by DB role).
    const validRoles = ['STUDENT', 'CANDIDATE', 'ADMIN', 'CAD'];
    const requestedRole = req.body.role ? String(req.body.role).toUpperCase() : null;
    if (requestedRole && !validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Invalid login role.');
    }

    // Find account by identifier
    const account = await findStudentByIdentifierOrEmail(userIdentifier.trim());

    // Check if account exists
    if (!account) {
      incFailedLogin();
      await recordAudit('login_failed', {
        ip: req.ip,
        metadata: { identifier: userIdentifier, role: requestedRole, reason: 'account_not_found' },
      });
      return authError(res, 401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    }

    // ENFORCE ROLE SEPARATION - Critical security check
    // When role is omitted (main portal), any DB role is accepted — the
    // frontend routes to the dashboard matching the returned DB role.
    if (requestedRole && account.role !== requestedRole) {
      incFailedLogin();
      await recordAudit('login_failed', {
        studentId: account.id,
        ip: req.ip,
        metadata: { identifier: userIdentifier, requestedRole, actualRole: account.role, reason: 'role_mismatch' },
      });
      // Use generic message to prevent account enumeration
      return authError(res, 401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    }

    // Check if account is locked
    if (isLocked(account)) {
      await recordAudit('login_locked', {
        studentId: account.id,
        ip: req.ip,
        metadata: { identifier: userIdentifier },
      });
      return authError(res, 423, 'ACCOUNT_LOCKED', 'This account is temporarily locked. Please try again later.');
    }

    // Verify password
    const valid = await verifyPassword(password, account.password_hash);
    if (!valid) {
      incFailedLogin();
      // Increment failed attempts and auto-lock at threshold. Uses the
      // shared helper so locked_until is set (the old raw UPDATE only bumped
      // the counter and never locked the account).
      await incrementFailedLogin(account);

      await recordAudit('login_failed', {
        studentId: account.id,
        ip: req.ip,
        metadata: { identifier: userIdentifier, reason: 'invalid_password' },
      });

      return authError(res, 401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    }

    // Reset failed attempts on successful password verification
    await updateStudentLogin(account.id);

    // ADMIN accounts require MFA
    if (account.role === 'ADMIN') {
      // Check for MFA bypass in development
      if (process.env.ALLOW_DEV_ADMIN === 'true' && process.env.NODE_ENV !== 'production') {
        const bindingToken = await createSession(res, account.id, true);
        await recordAudit('login_completed', {
          studentId: account.id,
          ip: req.ip,
          metadata: { method: 'mfa_bypass' },
        });
        return res.json({
          data: {
            authenticated: true,
            requiresPasswordChange: account.password_change_required,
            bindingToken,
            user: publicUser(account),
          },
        });
      }

      const requiresMfaSetup = !account.mfa_enabled;

      // Create MFA challenge
      const challenge = await createMfaChallenge(account.id, requiresMfaSetup);

      return res.json({
        data: {
          authenticated: false,
          mfaRequired: true,
          requiresMfaSetup,
          mfaChallenge: challenge.challenge,
          enrollmentToken: challenge.enrollmentToken || undefined,
        },
      });
    }

    // STUDENT and CANDIDATE get session directly
    const bindingToken = await createSession(res, account.id, false);

    await recordAudit('login_completed', {
      studentId: account.id,
      ip: req.ip,
    });

    return res.json({
      data: {
        authenticated: true,
        requiresPasswordChange: account.password_change_required,
        bindingToken,
        user: publicUser(account),
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred during login.');
  }
});

// =====================================================
// ADMIN PORTAL LOGIN (fixed email + password, no Clerk/Google)
//
// The admin portal (/login/admin) authenticates with a fixed credential
// instead of Google OAuth. The email must be present in ADMIN_EMAILS and the
// password must match ADMIN_PORTAL_PASSWORD (set on the server). The account
// is found or provisioned as ADMIN and a normal backend session is created.
// =====================================================
router.post('/admin-portal-login', loginLimiter, csrfProtection, async (req, res) => {
  try {
    incLoginAttempt();
    const { email, password } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return authError(res, 400, 'INVALID_INPUT', 'Email is required.');
    }
    if (!password || typeof password !== 'string') {
      return authError(res, 400, 'INVALID_INPUT', 'Password is required.');
    }

    const adminEmails = String(process.env.ADMIN_EMAILS || '')
      .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    const normalizedEmail = email.trim().toLowerCase();

    if (!adminEmails.includes(normalizedEmail)) {
      incFailedLogin();
      await recordAudit('admin_portal_login_denied', {
        ip: req.ip,
        metadata: { email: normalizedEmail, reason: 'not_in_admin_list' },
      });
      return authError(res, 403, 'NOT_ADMIN', 'This email is not authorized to access the admin portal.');
    }

    const fixedPassword = process.env.ADMIN_PORTAL_PASSWORD;
    if (!fixedPassword) {
      console.error('admin-portal-login: ADMIN_PORTAL_PASSWORD not configured');
      return authError(res, 500, 'NOT_CONFIGURED', 'Admin portal login is not configured on the server.');
    }

    const { timingSafeEqual } = require('node:crypto');
    const given = Buffer.from(String(password));
    const expected = Buffer.from(fixedPassword);
    const matches =
      given.length === expected.length && timingSafeEqual(given, expected);

    if (!matches) {
      incFailedLogin();
      await recordAudit('admin_portal_login_failed', {
        ip: req.ip,
        metadata: { email: normalizedEmail, reason: 'invalid_password' },
      });
      return authError(res, 401, 'INVALID_CREDENTIALS', 'Incorrect password.');
    }

    // Find by any login email; provision as ADMIN if it does not exist yet.
    const account = await db.query(
      `SELECT * FROM students
        WHERE LOWER(current_login_email) = LOWER($1)
           OR LOWER(email) = LOWER($1)
           OR LOWER(official_email) = LOWER($1)
        LIMIT 1`,
      [normalizedEmail]
    ).then((r) => r.rows[0]);

    let student;
    if (!account) {
      const name = normalizedEmail.split('@')[0] || 'Administrator';
      const usernameBase = normalizedEmail.split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase() || 'admin';
      const username = `${usernameBase}.${require('node:crypto').randomBytes(3).toString('hex')}`;
      const randomPassword = require('node:crypto').randomBytes(24).toString('base64url');
      const passwordHash = await hashPassword(randomPassword);
      const inserted = await db.query(
        `INSERT INTO students (external_id, name, email, current_login_email, official_email,
                              password_hash, role, is_active, username, email_verified)
         VALUES ($1, $2, $3, $3, $3, $4, 'ADMIN', TRUE, $5, TRUE)
         RETURNING *`,
        [`PORTAL-ADMIN-${require('node:crypto').randomBytes(4).toString('hex')}`, name, normalizedEmail, passwordHash, username]
      ).then((r) => r.rows[0]);
      student = inserted;
      console.log('admin-portal-login: provisioned admin', { email: normalizedEmail });
    } else {
      // Make sure the listed admin is active and promoted to ADMIN.
      const updated = await db.query(
        `UPDATE students SET role = 'ADMIN', is_active = TRUE WHERE id = $1 RETURNING *`,
        [account.id]
      ).then((r) => r.rows[0]);
      student = updated;
    }

    const bindingToken = await createSession(res, student.id, false);

    await recordAudit('admin_portal_login', {
      studentId: student.id,
      ip: req.ip,
      metadata: { role: 'ADMIN' },
    });

    return res.json({
      data: {
        authenticated: true,
        bindingToken,
        user: publicUser(student),
      },
    });
  } catch (error) {
    console.error('admin-portal-login error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred during login.');
  }
});

// =====================================================
// OTP: Send Login OTP
// =====================================================
router.post('/otp/send-login', otpLimiter, csrfProtection, async (req, res) => {
  try {
    const { email, role } = req.body;

    // Validate input
    if (!email || typeof email !== 'string') {
      return authError(res, 400, 'INVALID_INPUT', 'Email is required.');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.toLowerCase())) {
      return authError(res, 400, 'INVALID_EMAIL', 'Please enter a valid email address.');
    }

    // Validate role - only STUDENT and CANDIDATE can use OTP login
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = (role || 'STUDENT').toUpperCase();
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'OTP login is not available for this role.');
    }

    // Check rate limit
    const rateCheck = await checkRateLimit(email.toLowerCase(), 'LOGIN_OTP');
    if (!rateCheck.allowed) {
      return authError(res, 429, 'RATE_LIMITED',
        `Too many OTP requests. Please try again in ${Math.ceil(rateCheck.retryAfterMs / 1000)} seconds.`);
    }

    // Find account by email
    const account = await db.query(
      'SELECT * FROM students WHERE email = $1 AND is_active = TRUE',
      [email.toLowerCase()]
    ).then(r => r.rows[0]);

    if (account) {
      // Role comes from the ACCOUNT, not the portal picker: send the OTP
      // against the account's actual role so verification logs the user in
      // with their real role (frontend routes by the returned user.role).
      // Previously a role mismatch returned a fake "code sent" success without
      // creating an OTP — trapping the user in a verify-expired loop.
      const effectiveLoginRole = account.role || requestedRole;

      // Valid account - create OTP
      const { id: challengeId, otp, expiresAt } = await createOtpChallenge(
        email.toLowerCase(),
        'LOGIN_OTP',
        effectiveLoginRole,
        req.ip
      );

      // Send email
      try {
        await sendLoginOtp(email.toLowerCase(), otp);
      } catch (emailError) {
        console.error('Failed to send OTP email:', emailError.message);
        return authError(res, 500, 'EMAIL_FAILED', 'Failed to send verification code. Please try again.');
      }

      await recordAudit('otp_sent', {
        studentId: account.id,
        ip: req.ip,
        metadata: { purpose: 'LOGIN_OTP', role: effectiveLoginRole },
      });

      return res.json({
        data: {
          message: 'Verification code sent.',
          challengeId,
          expiresIn: 300, // 5 minutes in seconds
        },
      });
    } else {
      // No account exists - create OTP challenge anyway for account enumeration protection
      const { id: challengeId, otp, expiresAt } = await createOtpChallenge(
        email.toLowerCase(),
        'LOGIN_OTP',
        requestedRole,
        req.ip
      );

      // Send email (will fail for non-existent email, but that's expected)
      try {
        await sendLoginOtp(email.toLowerCase(), otp);
      } catch (emailError) {
        // Non-existent email - this is expected, don't show error
      }

      // Return same response as if account existed (account enumeration protection)
      return res.json({
        data: {
          message: 'If an account matches the information provided, a verification code has been sent.',
        },
      });
    }
  } catch (error) {
    // Handle RESEND_COOLDOWN error from createOtpChallenge
    if (error.message && error.message.startsWith('RESEND_COOLDOWN:')) {
      const seconds = error.message.split(':')[1];
      return authError(res, 429, 'RESEND_COOLDOWN',
        `Please wait ${seconds} seconds before requesting a new code.`);
    }
    // Log full error details for debugging (server-side only)
    console.error('OTP send error details:', {
      message: error.message,
      code: error.code,
      stack: error.stack,
      name: error.name,
    });
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// OTP: Verify Login OTP
// =====================================================
router.post('/otp/verify-login', otpLimiter, csrfProtection, async (req, res) => {
  try {
    const { email, otp, role } = req.body;

    if (!email || !otp) {
      return authError(res, 400, 'INVALID_INPUT', 'Verification code is required.');
    }

    // Validate role
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = (role || 'STUDENT').toUpperCase();
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Invalid role.');
    }

    // First check if account exists
    const accountData = await db.query(
      'SELECT * FROM students WHERE email = $1 AND is_active = TRUE',
      [email.toLowerCase()]
    ).then(r => r.rows[0]);

    if (!accountData) {
      // No account found - verify OTP is valid, then return needsRegistration
      // Use findValidChallenge to NOT mark OTP as used yet
      const { findValidChallenge, verifyOtp } = require('../services/otpService');
      const challenge = await findValidChallenge(email.toLowerCase(), 'LOGIN_OTP', requestedRole);

      if (!challenge) {
        return authError(res, 400, 'OTP_EXPIRED', 'Verification code has expired. Please request a new one.');
      }

      // Check attempt limit
      if (challenge.attempts >= 5) {
        await db.query('UPDATE otp_challenges SET used = TRUE WHERE id = $1', [challenge.id]);
        return authError(res, 400, 'MAX_ATTEMPTS', 'Too many attempts. Please request a new code.');
      }

      // Increment attempts but DON'T mark as used yet
      await db.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);

      // Verify OTP (but don't mark as used)
      if (!verifyOtp(otp, challenge.otp_hash)) {
        return authError(res, 400, 'INVALID_OTP', 'Invalid verification code.');
      }

      // Return needsRegistration so frontend can show registration form
      return res.json({
        data: {
          needsRegistration: true,
          email: email.toLowerCase(),
          role: requestedRole,
          message: 'No account found with this email. Please complete your registration.',
        },
      });
    }

    // Account exists - now verify OTP and mark as used
    const result = await verifyOtpChallenge(email.toLowerCase(), 'LOGIN_OTP', otp, requestedRole);

    if (!result.success) {
      if (result.error === 'EXPIRED') {
        return authError(res, 400, 'OTP_EXPIRED', 'Verification code has expired. Please request a new one.');
      }
      if (result.error === 'MAX_ATTEMPTS') {
        return authError(res, 400, 'MAX_ATTEMPTS', 'Too many attempts. Please request a new code.');
      }
      if (result.error === 'INVALID_OTP') {
        return authError(res, 400, 'INVALID_OTP', 'Invalid verification code.');
      }
      if (result.error === 'ALREADY_USED') {
        return authError(res, 400, 'OTP_USED', 'This code has already been used.');
      }
      return authError(res, 400, 'INVALID_OTP', 'Invalid verification code.');
    }

    // Log in with the ACCOUNT's actual role — the portal picker is advisory
    // only. The frontend routes by the returned user.role, so a candidate who
    // used the student portal still lands on the candidate dashboard.
    const actualRole = accountData.role || requestedRole;

    // Create session
    const bindingToken = await createSession(res, accountData.id, false);

    await recordAudit('otp_login_completed', {
      studentId: accountData.id,
      ip: req.ip,
      metadata: { role: actualRole },
    });

    return res.json({
      data: {
        authenticated: true,
        requiresPasswordChange: accountData.password_change_required,
        bindingToken,
        user: publicUser(accountData),
      },
    });
  } catch (error) {
    // Handle RESEND_COOLDOWN error
    if (error.message && error.message.startsWith('RESEND_COOLDOWN:')) {
      const seconds = error.message.split(':')[1];
      return authError(res, 429, 'RESEND_COOLDOWN',
        `Please wait ${seconds} seconds before requesting a new code.`);
    }
    console.error('OTP verify error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// OTP: Check if email has existing account
// =====================================================
router.post('/otp/check-email', otpLimiter, csrfProtection, async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email || typeof email !== 'string') {
      return authError(res, 400, 'INVALID_INPUT', 'Email is required.');
    }

    // Validate role
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = (role || 'STUDENT').toUpperCase();
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Invalid role.');
    }

    // Check if account exists
    const account = await db.query(
      'SELECT id, role FROM students WHERE email = $1 AND is_active = TRUE',
      [email.toLowerCase()]
    ).then(r => r.rows[0]);

    if (account) {
      // Account exists
      if (account.role !== requestedRole) {
        // Role mismatch - don't reveal which role the email belongs to
        return res.json({
          data: {
            emailExists: false,
            message: 'Please check your email for the verification code.',
          },
        });
      }
      return res.json({
        data: {
          emailExists: true,
          canLogin: true,
        },
      });
    }

    // No account - user needs to register
    return res.json({
      data: {
        emailExists: false,
        canLogin: false,
        needsRegistration: true,
      },
    });
  } catch (error) {
    console.error('Email check error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// OTP: Send Password Reset OTP
// =====================================================
router.post('/otp/send-reset', passwordResetLimiter, csrfProtection, async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email || typeof email !== 'string') {
      return authError(res, 400, 'INVALID_INPUT', 'Email is required.');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.toLowerCase())) {
      return authError(res, 400, 'INVALID_EMAIL', 'Please enter a valid email address.');
    }

    // Validate role - only STUDENT and CANDIDATE can reset password via OTP
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = (role || 'STUDENT').toUpperCase();
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Password reset is not available for this role.');
    }

    // Check rate limit
    const rateCheck = await checkRateLimit(email.toLowerCase(), 'PASSWORD_RESET');
    if (!rateCheck.allowed) {
      return authError(res, 429, 'RATE_LIMITED',
        `Too many reset requests. Please try again in ${Math.ceil(rateCheck.retryAfterMs / 1000)} seconds.`);
    }

    // Find account by email
    const account = await db.query(
      'SELECT * FROM students WHERE email = $1 AND is_active = TRUE',
      [email.toLowerCase()]
    ).then(r => r.rows[0]);

    if (account) {
      // Verify role matches
      if (account.role !== requestedRole) {
        // Generic response for role mismatch
        return res.json({
          data: {
            message: 'If an account matches the information provided, a reset code has been sent.',
          },
        });
      }

      // Create OTP
      const { id: challengeId, otp, expiresAt } = await createOtpChallenge(
        email.toLowerCase(),
        'PASSWORD_RESET',
        null, // No specific role for password reset
        req.ip
      );

      // Send email
      try {
        await sendPasswordResetOtp(email.toLowerCase(), otp);
      } catch (emailError) {
        console.error('Failed to send reset email:', emailError.message);
        return authError(res, 500, 'EMAIL_FAILED', 'Failed to send reset code. Please try again.');
      }

      await recordAudit('password_reset_requested', {
        studentId: account.id,
        ip: req.ip,
      });

      return res.json({
        data: {
          message: 'Reset code sent.',
          challengeId,
          expiresIn: 300,
        },
      });
    }

    // No account - generic response
    return res.json({
      data: {
        message: 'If an account matches the information provided, a reset code has been sent.',
      },
    });
  } catch (error) {
    // Handle RESEND_COOLDOWN error
    if (error.message && error.message.startsWith('RESEND_COOLDOWN:')) {
      const seconds = error.message.split(':')[1];
      return authError(res, 429, 'RESEND_COOLDOWN',
        `Please wait ${seconds} seconds before requesting a new code.`);
    }
    console.error('Password reset request error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// OTP: Verify Password Reset
// =====================================================
router.post('/otp/verify-reset', passwordResetLimiter, csrfProtection, async (req, res) => {
  try {
    const { email, otp, role } = req.body;

    if (!email || !otp) {
      return authError(res, 400, 'INVALID_INPUT', 'Reset code is required.');
    }

    // Validate role
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = (role || 'STUDENT').toUpperCase();
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Invalid role.');
    }

    // Find and verify the challenge. Signature: verifyOtpChallenge(email, purpose, otp, targetRole).
    // Returns { success:boolean, error:string|null, challenge:object|null }.
    const result = await verifyOtpChallenge(email, 'PASSWORD_RESET', otp, requestedRole);

    if (!result.success || !result.challenge) {
      if (result.error === 'EXPIRED') {
        return authError(res, 400, 'OTP_EXPIRED', 'Reset code has expired. Please request a new one.');
      }
      if (result.error === 'MAX_ATTEMPTS') {
        return authError(res, 400, 'MAX_ATTEMPTS', 'Too many attempts. Please request a new code.');
      }
      if (result.error === 'INVALID_OTP') {
        return authError(res, 400, 'INVALID_OTP', 'Invalid reset code.');
      }
      return authError(res, 400, 'INVALID_OTP', 'Invalid reset code.');
    }

    // The challenge carries the email + role, but no student_id — derive the
    // student account from the verified email.
    const account = await db.query(
      `SELECT id, role FROM students
        WHERE is_active = TRUE
          AND (LOWER(current_login_email) = LOWER($1)
               OR LOWER(email) = LOWER($1)
               OR LOWER(official_email) = LOWER($1))
        LIMIT 1`,
      [email]
    ).then(r => r.rows[0]);

    if (!account) {
      return authError(res, 400, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    }

    // Verify role matches the one the OTP was issued for.
    if (account.role !== requestedRole) {
      return authError(res, 400, 'INVALID_REQUEST', 'Reset code does not match the selected role.');
    }

    const studentId = account.id;
    const challengeId = result.challenge.id;

    await recordAudit('password_reset_verified', {
      studentId,
      ip: req.ip,
    });

    return res.json({
      data: {
        verified: true,
        resetChallengeId: challengeId,
        expiresIn: 300,
      },
    });
  } catch (error) {
    console.error('Password reset verify error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// Password Reset: Complete
// =====================================================
router.post('/reset-password', passwordResetLimiter, csrfProtection, async (req, res) => {
  try {
    const { challengeId, newPassword, confirmPassword, role } = req.body;

    if (!challengeId) {
      return authError(res, 400, 'INVALID_INPUT', 'Invalid reset request.');
    }

    if (!newPassword || !confirmPassword) {
      return authError(res, 400, 'INVALID_INPUT', 'Both passwords are required.');
    }

    if (newPassword !== confirmPassword) {
      return authError(res, 400, 'PASSWORD_MISMATCH', 'Passwords do not match.');
    }

    // Validate role
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = (role || 'STUDENT').toUpperCase();
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Invalid role.');
    }

    // Find the challenge (otp_challenges has email + target_role, no
    // student_id, so the account is derived from the challenge email + role).
    const challenge = await db.query(
      `SELECT c.*
       FROM otp_challenges c
       WHERE c.id = $1 AND c.purpose = 'PASSWORD_RESET' AND c.used = FALSE AND c.expires_at > NOW()`,
      [challengeId]
    ).then(r => r.rows[0]);

    if (!challenge) {
      return authError(res, 400, 'INVALID_CHALLENGE', 'Reset request not found or expired.');
    }

    // Derive the student account from the verified challenge email.
    const account = await db.query(
      `SELECT id, role FROM students
        WHERE is_active = TRUE
          AND (LOWER(current_login_email) = LOWER($1)
               OR LOWER(email) = LOWER($1)
               OR LOWER(official_email) = LOWER($1))
        LIMIT 1`,
      [challenge.email]
    ).then(r => r.rows[0]);

    if (!account) {
      return authError(res, 400, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    }

    // Verify role chosen for the reset matches the account's actual role.
    if (account.role !== requestedRole) {
      return authError(res, 400, 'INVALID_ROLE', 'Reset request does not match selected role.');
    }

    // Validate password policy
    const passwordError = validatePasswordPolicy(newPassword);
    if (passwordError) {
      return authError(res, 400, 'WEAK_PASSWORD', passwordError);
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword);

    // Update password and mark challenge as used
    await db.query('BEGIN');
    try {
      await db.query(
        'UPDATE students SET password_hash = $1, failed_login_attempts = 0 WHERE id = $2',
        [passwordHash, account.id]
      );
      await db.query(
        'UPDATE otp_challenges SET used = TRUE, consumed_at = NOW() WHERE id = $1',
        [challengeId]
      );
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }

    // Revoke all existing sessions for this user
    await db.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE student_id = $1 AND revoked_at IS NULL',
      [account.id]
    );

    await recordAudit('password_reset_completed', {
      studentId: account.id,
      ip: req.ip,
    });

    return res.json({
      data: {
        message: 'Password has been reset. Please sign in with your new password.',
      },
    });
  } catch (error) {
    console.error('Password reset error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// OTP: Register New Account
// =====================================================
async function registerOtpHandler(req, res) {
  try {
    const { email, username, password, confirmPassword, role } = req.body;

    // Validate input
    if (!email || typeof email !== 'string') {
      return authError(res, 400, 'INVALID_INPUT', 'Email is required.');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.toLowerCase())) {
      return authError(res, 400, 'INVALID_EMAIL', 'Please enter a valid email address.');
    }

    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return authError(res, 400, 'INVALID_USERNAME', 'Username must be at least 3 characters.');
    }

    if (!password || !confirmPassword) {
      return authError(res, 400, 'INVALID_INPUT', 'Both passwords are required.');
    }

    if (password !== confirmPassword) {
      return authError(res, 400, 'PASSWORD_MISMATCH', 'Passwords do not match.');
    }

    // Validate role - only STUDENT and CANDIDATE can register via OTP
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = (role || 'STUDENT').toUpperCase();
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Registration is not available for this role.');
    }

    // Check rate limit
    const rateCheck = await checkRateLimit(email.toLowerCase(), 'LOGIN_OTP');
    if (!rateCheck.allowed) {
      return authError(res, 429, 'RATE_LIMITED',
        `Too many registration attempts. Please try again in ${Math.ceil(rateCheck.retryAfterMs / 1000)} seconds.`);
    }

    // Check if email already exists
    const existingEmail = await db.query(
      'SELECT id, role FROM students WHERE email = $1 AND is_active = TRUE',
      [email.toLowerCase()]
    ).then(r => r.rows[0]);

    if (existingEmail) {
      if (existingEmail.role === requestedRole) {
        return authError(res, 400, 'EMAIL_EXISTS', 'An account with this email already exists.');
      }
      // Different role - generic response
      return authError(res, 400, 'EMAIL_EXISTS', 'An account with this email already exists.');
    }

    // Check if username already exists
    const existingUsername = await db.query(
      'SELECT id FROM students WHERE external_id = $1',
      [username.trim()]
    ).then(r => r.rows[0]);

    if (existingUsername) {
      return authError(res, 400, 'USERNAME_EXISTS', 'This username is already taken.');
    }

    // Validate password policy
    const passwordError = validatePasswordPolicy(password);
    if (passwordError) {
      return authError(res, 400, 'WEAK_PASSWORD', passwordError);
    }

    // Create OTP challenge with registration data
    const { id: challengeId, otp, expiresAt } = await createOtpChallenge(
      email.toLowerCase(),
      'LOGIN_OTP',
      requestedRole,
      req.ip
    );

    // DEV MODE: Log OTP to console as fallback
    console.log('\n========================================');
    console.log('DEV MODE - OTP for registration:');
    console.log('Email:', email);
    console.log('OTP:', otp);
    console.log('========================================\n');

    // Store registration data in a separate table or use the challenge
    // For simplicity, we'll store registration data in otp_challenges metadata
    // In production, use a separate registration_challenges table
    await db.query(
      `UPDATE otp_challenges SET rate_key = $1 WHERE id = $2`,
      [JSON.stringify({ username: username.trim(), passwordHash: await hashPassword(password), role: requestedRole }), challengeId]
    );

    // Send email
    try {
      await sendLoginOtp(email.toLowerCase(), otp);
    } catch (emailError) {
      console.error('Failed to send OTP email:', emailError.message);
      return authError(res, 500, 'EMAIL_FAILED', 'Failed to send verification code. Please try again.');
    }

    return res.json({
      data: {
        message: 'Verification code sent.',
        challengeId,
        expiresIn: 300,
        needsVerification: true,
      },
    });
  } catch (error) {
    // Handle RESEND_COOLDOWN error
    if (error.message && error.message.startsWith('RESEND_COOLDOWN:')) {
      const seconds = error.message.split(':')[1];
      return authError(res, 429, 'RESEND_COOLDOWN',
        `Please wait ${seconds} seconds before requesting a new code.`);
    }
    console.error('Registration OTP error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
}

router.post('/register/otp', registerLimiter, csrfProtection, registerOtpHandler);

// Per-role registration endpoints: the student and candidate forms each call
// their own API so the two flows cannot cross-wire roles.
router.post('/register/student/otp', registerLimiter, csrfProtection, (req, res) => {
  req.body.role = 'STUDENT';
  return registerOtpHandler(req, res);
});

router.post('/register/candidate/otp', registerLimiter, csrfProtection, (req, res) => {
  req.body.role = 'CANDIDATE';
  return registerOtpHandler(req, res);
});

// =====================================================
// OTP: Complete Registration
// =====================================================
async function registerVerifyHandler(req, res) {
  try {
    const { email, otp, username, fullName, mobileNumber, enrollmentNumber, password, role } = req.body;

    if (!email || !otp || !username || !password) {
      return authError(res, 400, 'INVALID_INPUT', 'All fields are required.');
    }

    // Validate role
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = (role || 'STUDENT').toUpperCase();
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Invalid role.');
    }

    // Check if email already exists (one email = one account)
    const existingEmail = await db.query(
      'SELECT id FROM students WHERE email = $1',
      [email.toLowerCase()]
    ).then(r => r.rows[0]);

    if (existingEmail) {
      return authError(res, 400, 'EMAIL_EXISTS', 'An account with this email already exists.');
    }

    // Check if username already exists
    const existingUsername = await db.query(
      'SELECT id FROM students WHERE username = $1',
      [username.trim().toLowerCase()]
    ).then(r => r.rows[0]);

    if (existingUsername) {
      return authError(res, 400, 'USERNAME_EXISTS', 'This username is already taken.');
    }

    // Validate mobile number if provided
    let formattedMobile = null;
    if (mobileNumber) {
      const mobileDigits = mobileNumber.replace(/\D/g, '');
      if (mobileDigits.length !== 10) {
        return authError(res, 400, 'INVALID_MOBILE', 'Mobile number must be 10 digits.');
      }
      formattedMobile = '+91' + mobileDigits;
    }

    // Find and verify the challenge
    const challenge = await db.query(
      `SELECT * FROM otp_challenges
       WHERE email = $1 AND purpose = 'LOGIN_OTP' AND used = FALSE AND expires_at > NOW()
         AND target_role = $2
       ORDER BY created_at DESC LIMIT 1`,
      [email.toLowerCase(), requestedRole]
    ).then(r => r.rows[0]);

    if (!challenge) {
      return authError(res, 400, 'INVALID_CHALLENGE', 'Verification code not found or expired.');
    }

    // Verify OTP
    const { verifyOtp: verify } = require('../services/otpService');
    const otpValid = verify(otp, challenge.otp_hash);

    if (!otpValid) {
      // Increment attempts
      await db.query(
        'UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1',
        [challenge.id]
      );

      // Check if max attempts reached
      if (challenge.attempts + 1 >= 5) {
        await db.query('UPDATE otp_challenges SET used = TRUE WHERE id = $1', [challenge.id]);
        return authError(res, 400, 'MAX_ATTEMPTS', 'Too many attempts. Please request a new code.');
      }

      return authError(res, 400, 'INVALID_OTP', 'Invalid verification code.');
    }

    // Get username and password from request body
    if (!username || !password) {
      return authError(res, 400, 'INVALID_INPUT', 'Username and password are required.');
    }

    // Verify role matches
    if (challenge.target_role !== requestedRole) {
      return authError(res, 400, 'ROLE_MISMATCH', 'Verification code does not match selected role.');
    }

    // Create the account
    const passwordHash = await hashPassword(password);
    await db.query('BEGIN');
    try {
      // Use username as external_id if enrollment number not provided
      const externalId = enrollmentNumber || username;

      const result = await db.query(
        `INSERT INTO students (external_id, name, email, password_hash, role, is_active, username, mobile_number, enrollment_number)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8)
         RETURNING id`,
        [externalId, fullName || username, email.toLowerCase(), passwordHash, requestedRole, username.trim().toLowerCase(), formattedMobile, enrollmentNumber || null]
      );

      const newStudentId = result.rows[0].id;

      // Mark challenge as used
      await db.query(
        'UPDATE otp_challenges SET used = TRUE, consumed_at = NOW() WHERE id = $1',
        [challenge.id]
      );

      await db.query('COMMIT');

      // Create session
      const bindingToken = await createSession(res, newStudentId, false);

      await recordAudit('account_created', {
        studentId: newStudentId,
        ip: req.ip,
        metadata: { role: requestedRole },
      });

      // Get the new account
      const newAccount = await db.query(
        'SELECT * FROM students WHERE id = $1',
        [newStudentId]
      ).then(r => r.rows[0]);

      return res.json({
        data: {
          authenticated: true,
          requiresPasswordChange: false,
          bindingToken,
          user: publicUser(newAccount),
        },
      });
    } catch (err) {
      await db.query('ROLLBACK');
      if (err.code === '23505') { // Unique constraint violation
        return authError(res, 400, 'USERNAME_EXISTS', 'This username is already taken.');
      }
      throw err;
    }
  } catch (error) {
    // Handle RESEND_COOLDOWN error
    if (error.message && error.message.startsWith('RESEND_COOLDOWN:')) {
      const seconds = error.message.split(':')[1];
      return authError(res, 429, 'RESEND_COOLDOWN',
        `Please wait ${seconds} seconds before requesting a new code.`);
    }
    console.error('Registration verify error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
}

router.post('/register/verify', otpLimiter, csrfProtection, registerVerifyHandler);

router.post('/register/student/verify', otpLimiter, csrfProtection, (req, res) => {
  req.body.role = 'STUDENT';
  return registerVerifyHandler(req, res);
});

router.post('/register/candidate/verify', otpLimiter, csrfProtection, (req, res) => {
  req.body.role = 'CANDIDATE';
  return registerVerifyHandler(req, res);
});

// =====================================================
// LOGOUT
// =====================================================
router.post('/logout', csrfProtection, async (req, res) => {
  try {
    // revokeSession(req, res) revokes the DB session row identified by the
    // cv_sid cookie and clears that cookie. Logout is always allowed: it runs
    // even when req.user was not populated (e.g. no binding token sent), and
    // it no-ops cleanly when there is no session cookie at all.
    await revokeSession(req, res);

    if (req.user && req.user.sessionId) {
      await recordAudit('logout', {
        studentId: req.user.studentId,
        sessionId: req.user.sessionId,
        ip: req.ip,
      });
    }

    // Clear the CSRF cookie regardless of whether a session was active.
    res.clearCookie(CSRF_COOKIE);

    return res.json({ data: { message: 'Logged out successfully.' } });
  } catch (error) {
    console.error('Logout error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred during logout.');
  }
});

// =====================================================
// MFA VERIFY
// =====================================================
router.post('/mfa/verify', mfaLimiter, csrfProtection, async (req, res) => {
  try {
    const { challenge, code } = req.body;

    if (!challenge || !code) {
      return authError(res, 400, 'INVALID_INPUT', 'Challenge and code are required.');
    }

    // Find challenge
    const challengeData = await findChallenge(challenge);

    if (!challengeData) {
      return authError(res, 400, 'INVALID_CHALLENGE', 'Invalid or expired challenge.');
    }

    if (challengeData.attempts >= 5) {
      await deleteChallenge(challengeData.id);
      return authError(res, 429, 'MAX_ATTEMPTS', 'Too many attempts. Please start over.');
    }

    // Verify TOTP (signature: verifyTotp(secret, code, timestamp))
    const isValid = await verifyTotp(decryptSecret(challengeData.mfa_secret_encrypted), code);

    if (!isValid) {
      await incrementChallengeAttempts(challengeData.id);
      return authError(res, 400, 'INVALID_CODE', 'Invalid verification code.');
    }

    // Mark MFA as verified in session
    const bindingToken = await createSession(res, challengeData.student_id, true);
    await deleteChallenge(challengeData.id);

    await recordAudit('mfa_verified', {
      studentId: challengeData.student_id,
      ip: req.ip,
    });

    const account = await db.query(
      'SELECT * FROM students WHERE id = $1',
      [challengeData.student_id]
    ).then(r => r.rows[0]);

    return res.json({
      data: {
        authenticated: true,
        requiresPasswordChange: account.password_change_required,
        bindingToken,
        user: publicUser(account),
      },
    });
  } catch (error) {
    console.error('MFA verify error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// MFA SETUP
// =====================================================
router.post('/mfa/setup', mfaLimiter, csrfProtection, async (req, res) => {
  try {
    if (!req.user || !req.user.studentId) {
      return authError(res, 401, 'NOT_AUTHENTICATED', 'Authentication required.');
    }

    const studentId = req.user.studentId;
    const account = await db.query(
      'SELECT * FROM students WHERE id = $1',
      [studentId]
    ).then(r => r.rows[0]);

    if (!account) {
      return authError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    }

    if (account.mfa_enabled) {
      return authError(res, 400, 'MFA_ALREADY_ENABLED', 'MFA is already enabled.');
    }

    // Generate new TOTP secret. generateTotpSecret() returns a base32 string;
    // provisioningUri(secret, identifier) builds the otpauth:// URI for the QR.
    const secret = generateTotpSecret();
    const uri = provisioningUri(secret, account.email);

    // Encrypt and store the secret
    const encryptedSecret = encryptSecret(secret);

    await db.query(
      'UPDATE students SET mfa_secret_encrypted = $1 WHERE id = $2',
      [encryptedSecret, studentId]
    );

    // Get the challenge token from the request
    const { enrollmentToken } = req.body;

    if (!enrollmentToken) {
      return authError(res, 400, 'INVALID_INPUT', 'Enrollment token is required.');
    }

    // Verify enrollment token
    const challengeData = await db.query(
      `SELECT * FROM mfa_challenges
       WHERE enrollment_hash = $1 AND student_id = $2 AND expires_at > NOW()`,
      [hashToken(enrollmentToken), studentId]
    ).then(r => r.rows[0]);

    if (!challengeData) {
      return authError(res, 400, 'INVALID_TOKEN', 'Invalid or expired enrollment token.');
    }

    await recordAudit('mfa_setup_started', {
      studentId,
      ip: req.ip,
    });

    return res.json({
      data: {
        secret,
        uri,
        message: 'Scan the QR code with your authenticator app, then verify with a code.',
      },
    });
  } catch (error) {
    console.error('MFA setup error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// MFA VERIFY SETUP
// =====================================================
router.post('/mfa/verify-setup', mfaLimiter, csrfProtection, async (req, res) => {
  try {
    if (!req.user || !req.user.studentId) {
      return authError(res, 401, 'NOT_AUTHENTICATED', 'Authentication required.');
    }

    const studentId = req.user.studentId;
    const { code, challenge } = req.body;

    if (!code) {
      return authError(res, 400, 'INVALID_INPUT', 'Verification code is required.');
    }

    const account = await db.query(
      'SELECT * FROM students WHERE id = $1',
      [studentId]
    ).then(r => r.rows[0]);

    if (!account) {
      return authError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    }

    if (account.mfa_enabled) {
      return authError(res, 400, 'MFA_ALREADY_ENABLED', 'MFA is already enabled.');
    }

    if (!account.mfa_secret_encrypted) {
      return authError(res, 400, 'MFA_NOT_SETUP', 'Please start MFA setup first.');
    }

    // Verify the code (signature: verifyTotp(secret, code, timestamp))
    const secret = decryptSecret(account.mfa_secret_encrypted);
    const isValid = await verifyTotp(secret, code);

    if (!isValid) {
      return authError(res, 400, 'INVALID_CODE', 'Invalid verification code.');
    }

    // Enable MFA
    await db.query(
      'UPDATE students SET mfa_enabled = TRUE WHERE id = $1',
      [studentId]
    );

    // Delete the challenge
    if (challenge) {
      await db.query(
        'DELETE FROM mfa_challenges WHERE challenge_hash = $1',
        [hashToken(challenge)]
      );
    }

    await recordAudit('mfa_enabled', {
      studentId,
      ip: req.ip,
    });

    return res.json({
      data: {
        message: 'MFA has been enabled successfully.',
      },
    });
  } catch (error) {
    console.error('MFA verify setup error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// CHANGE PASSWORD
// =====================================================
router.post('/change-password', loadSession, requireAuth, csrfProtection, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return authError(res, 400, 'INVALID_INPUT', 'All passwords are required.');
    }

    if (newPassword !== confirmPassword) {
      return authError(res, 400, 'PASSWORD_MISMATCH', 'New passwords do not match.');
    }

    const account = await db.query(
      'SELECT * FROM students WHERE id = $1',
      [req.user.studentId]
    ).then(r => r.rows[0]);

    if (!account) {
      return authError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    }

    // Verify current password
    const valid = await verifyPassword(currentPassword, account.password_hash);
    if (!valid) {
      return authError(res, 400, 'INVALID_PASSWORD', 'Current password is incorrect.');
    }

    // Validate new password
    const passwordError = validatePasswordPolicy(newPassword);
    if (passwordError) {
      return authError(res, 400, 'WEAK_PASSWORD', passwordError);
    }

    // Hash and update
    const passwordHash = await hashPassword(newPassword);
    await db.query(
      'UPDATE students SET password_hash = $1, password_change_required = FALSE WHERE id = $2',
      [passwordHash, req.user.studentId]
    );

    // Revoke all other sessions (session fixation protection)
    await db.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE student_id = $1 AND id != $2 AND revoked_at IS NULL',
      [req.user.studentId, req.user.sessionId]
    );

    await recordAudit('password_changed', {
      studentId: req.user.studentId,
      ip: req.ip,
    });

    return res.json({
      data: {
        message: 'Password changed successfully.',
      },
    });
  } catch (error) {
    console.error('Change password error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred.');
  }
});

// =====================================================
// REGISTER (for admin-approved registration)
// =====================================================
router.post('/register', registerLimiter, csrfProtection, async (req, res) => {
  try {
    const {
      username,
      fullName,
      email,
      mobileNumber,
      enrollmentNumber,
      password,
      confirmPassword
    } = req.body;

    // Validate all required fields
    if (!username || !fullName || !email || !mobileNumber || !enrollmentNumber || !password || !confirmPassword) {
      return authError(res, 400, 'INVALID_INPUT', 'All fields are required.');
    }

    // Validate password match
    if (password !== confirmPassword) {
      return authError(res, 400, 'PASSWORD_MISMATCH', 'Passwords do not match.');
    }

    // Validate username (3-30 chars, alphanumeric and underscore only)
    const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;
    if (!usernameRegex.test(username.trim())) {
      return authError(res, 400, 'INVALID_USERNAME', 'Username must be 3-30 characters (letters, numbers, underscore only).');
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.toLowerCase())) {
      return authError(res, 400, 'INVALID_EMAIL', 'Please enter a valid email address.');
    }

    // Validate mobile number (10 digits, auto-add +91)
    const mobileDigits = mobileNumber.replace(/\D/g, '');
    if (mobileDigits.length !== 10) {
      return authError(res, 400, 'INVALID_MOBILE', 'Mobile number must be 10 digits.');
    }
    const formattedMobile = '+91' + mobileDigits;

    // Validate enrollment number (not empty, trimmed)
    if (enrollmentNumber.trim().length < 3) {
      return authError(res, 400, 'INVALID_ENROLLMENT', 'Please enter a valid enrollment number.');
    }

    // Validate password strength
    const passwordError = validatePasswordPolicy(password);
    if (passwordError) {
      return authError(res, 400, 'WEAK_PASSWORD', passwordError);
    }

    // Check if username exists
    const existingUsername = await db.query(
      'SELECT id FROM students WHERE username = $1',
      [username.trim().toLowerCase()]
    ).then(r => r.rows[0]);

    if (existingUsername) {
      return authError(res, 400, 'USERNAME_EXISTS', 'This username is already taken.');
    }

    // Check if email exists
    const existingEmail = await db.query(
      'SELECT id FROM students WHERE email = $1',
      [email.toLowerCase()]
    ).then(r => r.rows[0]);

    if (existingEmail) {
      return authError(res, 400, 'EMAIL_EXISTS', 'An account with this email already exists.');
    }

    // Check if enrollment number exists
    const existingEnrollment = await db.query(
      'SELECT id FROM students WHERE external_id = $1',
      [enrollmentNumber.trim()]
    ).then(r => r.rows[0]);

    if (existingEnrollment) {
      return authError(res, 400, 'DUPLICATE_ENROLLMENT', 'This enrollment number is already registered.');
    }

    // Check if mobile exists
    const existingMobile = await db.query(
      'SELECT id FROM students WHERE mobile_number = $1',
      [formattedMobile]
    ).then(r => r.rows[0]);

    if (existingMobile) {
      return authError(res, 400, 'MOBILE_EXISTS', 'This mobile number is already registered.');
    }

    // Create registration request (admin approval required)
    const passwordHash = await hashPassword(password);
    await db.query(
      `INSERT INTO registration_requests (full_name, email, student_identifier, password_hash, username, mobile_number)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [fullName.trim(), email.toLowerCase(), enrollmentNumber.trim(), passwordHash, username.trim().toLowerCase(), formattedMobile],
    );

    await recordAudit('registration_requested', {
      ip: req.ip,
      metadata: { username: username.trim(), enrollmentNumber: enrollmentNumber.trim() },
    });

    return res.status(202).json({
      data: {
        message: 'Registration submitted for administrator approval.',
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred during registration.');
  }
});

// =====================================================
// Instant Registration (creates account immediately)
// =====================================================
router.post('/register/instant', registerLimiter, csrfProtection, async (req, res) => {
  try {
    const { email, username, fullName, mobileNumber, enrollmentNumber, password, confirmPassword, role } = req.body;

    // Validate all fields
    if (!email || !username || !fullName || !enrollmentNumber || !password || !confirmPassword) {
      return authError(res, 400, 'INVALID_INPUT', 'All fields are required.');
    }

    if (password !== confirmPassword) {
      return authError(res, 400, 'PASSWORD_MISMATCH', 'Passwords do not match.');
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.toLowerCase())) {
      return authError(res, 400, 'INVALID_EMAIL', 'Invalid email format.');
    }

    // Validate username
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return authError(res, 400, 'INVALID_USERNAME', 'Username must be 3-30 characters, alphanumeric and underscores only.');
    }

    // Validate password strength
    const passwordError = validatePasswordPolicy(password);
    if (passwordError) {
      return authError(res, 400, 'WEAK_PASSWORD', passwordError);
    }

    // Validate enrollment
    if (enrollmentNumber.trim().length < 4) {
      return authError(res, 400, 'INVALID_ENROLLMENT', 'Enrollment number must be at least 4 characters.');
    }

    // Validate mobile
    let formattedMobile = null;
    if (mobileNumber) {
      const digits = mobileNumber.replace(/\D/g, '');
      if (digits.length !== 10) {
        return authError(res, 400, 'INVALID_MOBILE', 'Mobile must be 10 digits.');
      }
      formattedMobile = '+91' + digits;
    }

    // Validate role
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = (role || 'STUDENT').toUpperCase();
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Invalid role.');
    }

    // Check duplicates
    const existingEmail = await db.query(
      'SELECT id FROM students WHERE LOWER(email) = LOWER($1)',
      [email.toLowerCase()]
    ).then(r => r.rows[0]);

    if (existingEmail) {
      return authError(res, 400, 'EMAIL_EXISTS', 'An account with this email already exists.');
    }

    const existingUsername = await db.query(
      'SELECT id FROM students WHERE LOWER(username) = LOWER($1)',
      [username.trim().toLowerCase()]
    ).then(r => r.rows[0]);

    if (existingUsername) {
      return authError(res, 400, 'USERNAME_EXISTS', 'This username is already taken.');
    }

    const existingEnrollment = await db.query(
      'SELECT id FROM students WHERE LOWER(external_id) = LOWER($1)',
      [enrollmentNumber.trim()]
    ).then(r => r.rows[0]);

    if (existingEnrollment) {
      return authError(res, 400, 'ENROLLMENT_EXISTS', 'This enrollment number is already registered.');
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create account
    const result = await db.query(
      `INSERT INTO students (username, external_id, name, email, password_hash, mobile_number, enrollment_number, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
       RETURNING id, username, external_id, name, email, role`,
      [username.trim().toLowerCase(), 'EXT-' + Date.now(), fullName.trim(), email.toLowerCase(), passwordHash, formattedMobile, enrollmentNumber.trim().toUpperCase(), requestedRole]
    );

    const newUser = result.rows[0];

    // Create session (sets session cookie automatically)
    await createSession(res, newUser.id);

    await recordAudit('registration_completed', {
      studentId: newUser.id,
      email: newUser.email,
      role: requestedRole,
      ip: req.ip,
    });

    return res.status(201).json({
      data: {
        success: true,
        message: 'Account created successfully!',
        user: {
          id: newUser.id,
          username: newUser.username,
          name: newUser.name,
          email: newUser.email,
          role: newUser.role,
        },
      },
    });

  } catch (error) {
    console.error('Instant registration error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred during registration.');
  }
});

// =====================================================
// CLERK-PROOF REGISTRATION (email → OTP code → name + roll number)
//
// The frontend collects the email, completes a Clerk email-code challenge
// (Clerk sends the OTP email), then calls this endpoint with the Clerk
// session token as a Bearer token to prove email ownership. We resolve the
// email server-side, create the account (no password — sign-in is always via
// a one-time code) with name + roll number, and return a backend session
// (cv_sid cookie).
//
// Roles: registration creates a STUDENT account used to apply as a
// candidate (CANDIDATE is earned when an admin approves the application).
// STUDENT-portal registration is gated by the frontend for now; only the
// candidate registration is open. ADMIN is NEVER created here — admins are
// provisioned via ADMIN_EMAILS.
// =====================================================
// =====================================================
// CLERK-PROOF REGISTRATION (OTP email code → verified Clerk token)
//
// Authenticates exclusively with Authorization: Bearer <Clerk JWT>
// (verified against Clerk's JWKS in clerkVerify.js). Browsers never attach
// an Authorization header on their own, so this endpoint is CSRF-immune by
// design: the double-submit cookie check only protects cookie-authenticated
// flows. Exempting ONLY this route (no CSRF cookie) lets the cross-site
// Vercel/Render frontend register without weakening CSRF for any
// cookie/session-authenticated route.
// =====================================================
router.post('/register/clerk', registerLimiter, requireClerkMiddleware, async (req, res) => {
  try {
    const { rollNumber, fullName, role, mobileNumber, password } = req.body;

    // Role: STUDENT (default) or CANDIDATE (registers a student account for
    // the candidate application flow). CAD is no longer registrable and
    // ADMIN is never self-service.
    const validRoles = ['STUDENT', 'CANDIDATE'];
    const requestedRole = role ? String(role).toUpperCase() : 'STUDENT';
    if (!validRoles.includes(requestedRole)) {
      return authError(res, 400, 'INVALID_ROLE', 'Invalid registration role.');
    }
    // Candidacy is earned via application approval, never granted at signup.
    const storedRole = 'STUDENT';

    // ---- 1. Prove email ownership via the Clerk session token ----
    let verified;
    try {
      verified = await verifyClerkSessionRequest(req);
    } catch (err) {
      console.error('register/clerk: token verification failed:', err.message);
      return authError(res, err.status || 401, err.code || 'INVALID_CLERK_TOKEN',
        'Email verification could not be confirmed. Please request a new code.');
    }
    const email = verified.email;

    // ---- 2. Existing account? Point them at sign-in ----
    const existing = await db.query(
      `SELECT id, role, password_hash FROM students
        WHERE LOWER(current_login_email) = LOWER($1) OR LOWER(email) = LOWER($1)
        LIMIT 1`,
      [email]
    ).then((r) => r.rows[0]);

    if (existing) {
      return authError(res, 409, 'EMAIL_EXISTS',
        'An account with this email already exists. Please sign in with the one-time code sent to your email.');
    }

    // ---- 3. Validate roll number + name ----
    // Roll number is required for direct student registration, optional when
    // registering through the candidate portal (the application form collects
    // the enrollment number anyway).
    const roll = String(rollNumber || '').trim();
    if (roll && (roll.length < 3 || roll.length > 64)) {
      return authError(res, 400, 'INVALID_ROLL', 'Please enter a valid roll / enrollment number (3-64 characters).');
    }
    if (!roll && requestedRole === 'STUDENT') {
      return authError(res, 400, 'INVALID_ROLL', 'Please enter a valid roll / enrollment number (3-64 characters).');
    }

    const name = String(fullName || '').trim();
    if (!name || name.length < 2 || name.length > 255) {
      return authError(res, 400, 'INVALID_NAME', 'Please enter your full name (2-255 characters).');
    }
    // Registration name IS the account name — it pre-fills the candidate
    // application form and shows on dashboards/profile.

    // ---- Password (required; used for email + password sign-in) ----
    if (!password || typeof password !== 'string') {
      return authError(res, 400, 'INVALID_PASSWORD', 'Please choose a password (at least 12 characters).');
    }
    const passwordPolicyError = validatePasswordPolicy(password, email.split('@')[0]);
    if (passwordPolicyError) {
      return authError(res, 400, 'INVALID_PASSWORD', passwordPolicyError);
    }

    // ---- Phone / mobile number (required) ----
    const phone = String(mobileNumber || '').replace(/[\s()-]/g, '');
    if (!phone || !/^\+?[0-9]{10,15}$/.test(phone)) {
      return authError(res, 400, 'INVALID_PHONE', 'Please enter a valid phone number (10-15 digits).');
    }

    // ---- 4. Create the account (Clerk user keeps the password too) ----
    const identifier = email.split('@')[0];
    const passwordHash = await hashPassword(password);
    let account;

    // Duplicate roll number → the roll number IS the student identity.
    if (roll) {
      const dupRoll = await db.query(
        'SELECT id FROM students WHERE LOWER(roll_number) = LOWER($1) LIMIT 1',
        [roll]
      ).then((r) => r.rows[0]);
      if (dupRoll) {
        return authError(res, 409, 'ROLL_EXISTS',
          'This roll number is already registered. If it is yours, sign in instead or contact the administrator.');
      }
    }

    const inserted = await db.query(
      `INSERT INTO students (external_id, name, email, current_login_email, password_hash,
                             roll_number, mobile_number, role, is_active, email_verified, username)
       VALUES ($1, $2, $3, $3, $4, NULLIF($5, ''), $6, $7, TRUE, TRUE, $8)
       RETURNING *`,
      [`REG-${Date.now()}`, name, email, passwordHash, roll, phone, storedRole, `${identifier.replace(/[^a-z0-9._-]/gi, '').toLowerCase() || 'user'}.${Date.now().toString(36).slice(-4)}`]
    ).then((r) => r.rows[0]);
    account = inserted;

    // ---- 5. Session ----
    const bindingToken = await createSession(res, account.id, false);

    await recordAudit('registration_completed', {
      studentId: account.id,
      ip: req.ip,
      metadata: { method: 'clerk_email_code', email },
    });

    return res.status(201).json({
      data: {
        authenticated: true,
        bindingToken,
        user: publicUser(account),
      },
    });
  } catch (error) {
    console.error('Clerk registration error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred during registration.');
  }
});

// =====================================================
// CLERK-PROOF EMAIL RECOVERY (email → OTP code → session)
//
// Same email-ownership proof as registration, for accounts that already
// exist. Accounts have no password in the OTP flow, so there is nothing to
// reset: a verified email yields a fresh session directly. Kept behind the
// same endpoint name so older clients that still POST here never receive a
// password-change response.
// =====================================================
router.post('/forgot-password/clerk', passwordResetLimiter, csrfProtection, requireClerkMiddleware, async (req, res) => {
  try {
    // ---- 1. Prove email ownership via the Clerk session token ----
    let verified;
    try {
      verified = await verifyClerkSessionRequest(req);
    } catch (err) {
      console.error('forgot-password/clerk: token verification failed:', err.message);
      return authError(res, err.status || 401, err.code || 'INVALID_CLERK_TOKEN',
        'Email verification could not be confirmed. Please request a new code.');
    }
    const email = verified.email;

    // ---- 2. Account must exist ----
    const account = await db.query(
      `SELECT * FROM students
        WHERE is_active = TRUE
          AND (LOWER(current_login_email) = LOWER($1) OR LOWER(email) = LOWER($1))
        LIMIT 1`,
      [email]
    ).then((r) => r.rows[0]);

    if (!account) {
      return authError(res, 404, 'ACCOUNT_NOT_FOUND',
        'No account exists for this email. Please register first.');
    }

    // ---- 3. Authenticate the verified email (no password exists to reset) ----
    const bindingToken = await createSession(res, account.id, false);

    await recordAudit('email_recovery_signin', {
      studentId: account.id,
      ip: req.ip,
      metadata: { method: 'clerk_email_code' },
    });

    return res.json({
      data: {
        authenticated: true,
        bindingToken,
        user: publicUser(account),
      },
    });
  } catch (error) {
    console.error('Clerk email recovery error:', error);
    return authError(res, 500, 'INTERNAL_ERROR', 'An error occurred during recovery sign-in.');
  }
});

module.exports = router;
