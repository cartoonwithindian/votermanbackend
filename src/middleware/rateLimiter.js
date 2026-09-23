/**
 * Rate Limiting Middleware
 * Rate limiters for authentication and voting endpoints
 *
 * NOTE: These limiters use in-memory storage.
 * For horizontal scaling, use Redis-based rate limiting.
 */

const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for login attempts
 * 30 attempts per 15 minutes
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Too many authentication attempts. Please try again later.',
    code: 'RATE_LIMITED',
  },
});

/**
 * Rate limiter for MFA attempts
 * 20 attempts per 5 minutes
 */
const mfaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Too many MFA attempts. Please try again later.',
    code: 'RATE_LIMITED',
  },
});

/**
 * Rate limiter for registration attempts
 * 5 attempts per hour
 */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Too many registration attempts. Please try again later.',
    code: 'RATE_LIMITED',
  },
});

/**
 * Rate limiter for voting
 * 10 votes per minute (prevents rapid duplicate voting)
 */
const voteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: parseInt(process.env.VOTE_LIMIT_MAX, 10) || 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Voting rate limit exceeded. Please wait a moment.',
    code: 'RATE_LIMITED',
  },
});

/**
 * Rate limiter for OTP requests (login and password reset)
 * 10 OTP requests per 15 minutes per IP
 */
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Too many OTP requests. Please try again later.',
    code: 'RATE_LIMITED',
  },
});

/**
 * Rate limiter for password reset attempts
 * 5 attempts per hour
 */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Too many password reset attempts. Please try again later.',
    code: 'RATE_LIMITED',
  },
});

module.exports = {
  loginLimiter,
  mfaLimiter,
  registerLimiter,
  voteLimiter,
  otpLimiter,
  passwordResetLimiter,
};
