const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const healthRoutes = require('./routes/health');
const studentRoutes = require('./routes/students');
const electionRoutes = require('./routes/elections');
const announcementRoutes = require('./routes/announcements');
const positionRoutes = require('./routes/positions');
const candidateRoutes = require('./routes/candidates');
const candidateApplicationRoutes = require('./routes/candidateApplications');
const adminCandidateAppRoutes = require('./routes/adminCandidateApplications');
const authorizationRoutes = require('./routes/authorization');
const authRoutes = require('./routes/auth');
const clerkAuthRoutes = require('./routes/clerkAuth');
const emailRecoveryRoutes = require('./routes/emailRecovery');
const adminEmailRecoveryRoutes = require('./routes/adminEmailRecovery');
const accessRequestRoutes = require('./routes/accessRequests');
const adminAccessRequestRoutes = require('./routes/adminAccessRequests');
const cadRoutes = require('./routes/cad');
const adminStats = require('./controllers/adminStats');
const adminLiveResults = require('./controllers/adminLiveResults');
const adminAuditLogs = require('./controllers/adminAuditLogs');
const positionController = require('./controllers/positionController');
const candidateController = require('./controllers/candidateController');
const studentController = require('./controllers/studentController');
const authController = require('./controllers/authorizationController');
const voteController = require('./controllers/voteController');
const adminStudents = require('./routes/adminStudents');
const adminElections = require('./routes/adminElections');
const adminPositions = require('./routes/adminPositions');
const adminCandidates = require('./routes/adminCandidates');
const adminAuthorization = require('./routes/adminAuthorization');
const adminAnnouncements = require('./routes/adminAnnouncements');
const adminSupport = require('./routes/adminSupport');
const voteRoutes = require('./routes/votes');
const constituencyRoutes = require('./routes/constituencies');
const adminConstituencyRoutes = require('./routes/adminConstituencies');
const receiptRoutes = require('./routes/receipts');
const notificationRoutes = require('./routes/notifications');
const supportRoutes = require('./routes/support');
const uploadsRoutes = require('./routes/uploads');
const { loadSession } = require('./middleware/loadSession');
const { requireAuth } = require('./middleware/requireAuth');
const { requireAdmin } = require('./middleware/requireAdmin');
const { httpMetricsMiddleware, metricsHandler, buildMonitoringSummary } = require('./monitoring/metrics');
const { getMongoDbName } = require('../utils/mongoDbName');

const app = express();
const isDev = process.env.NODE_ENV !== 'production';

// Trust the first proxy hop (Render's reverse proxy) so req.ip reflects the
// real client IP. Without this, every user shares the proxy IP and the
// per-IP rate limiters (login, register, voting) become global.
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: isDev ? false : undefined,
}));

// CORS configuration.
// No origins are hardcoded. Every allowed origin comes from env so the app
// works on any deployment without code changes:
//   - CORS_ORIGIN           comma-separated list of allowed origins
//   - CORS_ORIGIN_PATTERNS  optional wildcard/regex patterns (see below)
//   - APP_URL               canonical app URL (added automatically)
//   - CLERK_APP_DOMAIN      Clerk custom front-end API domain (added automatically)
//   - CLERK_APP_DOMAIN_S1   optional secondary Clerk domain (added automatically)
const clerkAppDomain = process.env.CLERK_APP_DOMAIN || '';
const clerkS1Domain = process.env.CLERK_APP_DOMAIN_S1 || '';
const appOrigin = (process.env.APP_URL || '').replace(/\/+$/, '');
const allowedOrigins = Array.from(new Set(
  [
    ...(process.env.CORS_ORIGIN || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean),
    'http://127.0.0.1:3001',
    appOrigin,
    clerkAppDomain && `https://${clerkAppDomain.replace(/^https?:\/\//, '')}`,
    clerkS1Domain && `https://${clerkS1Domain.replace(/^https?:\/\//, '')}`,
  ].filter(Boolean)
));

const corsOptions = {
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);

    // Check for pattern-based origins (e.g., *.vercel.app) configured via env
    const patternOrigins = process.env.CORS_ORIGIN_PATTERNS
      ? process.env.CORS_ORIGIN_PATTERNS.split(',').map(p => p.trim())
      : [];

    for (const pattern of patternOrigins) {
      // Handle wildcard patterns like *.vercel.app
      if (pattern.startsWith('*.')) {
        const domain = pattern.slice(2);
        const regex = new RegExp(`^https://[^.]+\.${domain.replace(/\./g, '\\.')}$`);
        if (regex.test(origin)) return cb(null, true);
      }
      // Handle exact domain patterns
      if (pattern.startsWith('/') && pattern.endsWith('/')) {
        try {
          const regex = new RegExp(pattern.slice(1, -1));
          if (regex.test(origin)) return cb(null, true);
        } catch (e) {
          // Invalid regex, skip
        }
      }
    }

    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Session-Binding'],
};
app.use(cors(corsOptions));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Cookie parsing
app.use(cookieParser());

// =====================================================
// PROMETHEUS HTTP METRICS (observability — additive only)
// Measures every request except the /metrics scrape itself.
// =====================================================
app.use(httpMetricsMiddleware);

// Prometheus scrape endpoint (bearer-token protected; see monitoring/metrics.js)
app.get('/metrics', metricsHandler);

// =====================================================
// SESSION LOADING (runs on every request before route handlers)
// =====================================================
app.use(loadSession);

// =====================================================
// PUBLIC ROUTES (no authentication required)
// =====================================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'voteweb-api',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health/db', async (req, res) => {
  const db = require('./db');
  const start = Date.now();
  // MongoDB-only (Atlas M10) — check Mongo ping when Postgres not configured
  if (!process.env.DATABASE_URL && process.env.MONGODB_URI) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI);
      await client.connect();
      await client.db(getMongoDbName()).command({ ping: 1 });
      await client.close();
      res.json({
        status: 'ok',
        database: 'connected',
        backend: 'mongodb',
        responseTime: `${Date.now() - start}ms`,
        timestamp: new Date().toISOString(),
      });
      return;
    } catch (err) {
      res.status(503).json({
        status: 'error',
        database: 'disconnected',
        backend: 'mongodb',
        message: 'MongoDB connection failed: ' + err.message,
        timestamp: new Date().toISOString(),
      });
      return;
    }
  }
  try {
    await db.query('SELECT 1');
    res.json({
      status: 'ok',
      database: 'connected',
      backend: 'postgres',
      responseTime: `${Date.now() - start}ms`,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      database: 'disconnected',
      backend: 'postgres',
      message: 'Database connection failed',
      timestamp: new Date().toISOString(),
    });
  }
});

// Brevo/Email configuration check (booleans only — never leak the API key,
// sender address, or key prefix to unauthenticated health probes).
app.get('/api/health/brevo', (req, res) => {
  res.json({
    hasApiKey: !!process.env.BREVO_API_KEY,
    hasSenderEmail: !!process.env.BREVO_SENDER_EMAIL,
    hasSenderName: !!process.env.BREVO_SENDER_NAME,
  });
});

// Auth routes (login, logout, MFA, etc.)
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/auth', clerkAuthRoutes); // Clerk Google sign-in bridge
app.use('/api/v1/auth', emailRecoveryRoutes); // public: can't access your registered email?
app.use('/api/v1/access-requests', accessRequestRoutes); // public: request voting access

// Elections (public read for published elections)
app.use('/api/v1/elections', electionRoutes);

// Public announcements (published only)
app.use('/api/v1/announcements', announcementRoutes);

// Position-candidate relationships (public read)
app.get('/api/v1/positions/:positionId/candidates', candidateController.list.bind(candidateController));

// Positions (public read)
app.use('/api/v1/positions', positionRoutes);

// Constituencies (public read — CR ballot data)
app.use('/api/v1/constituencies', constituencyRoutes);

// Candidates (public read)
app.use('/api/v1/candidates', candidateRoutes);

// Candidate Applications (authenticated students)
app.use('/api/candidates', candidateApplicationRoutes);

// Authorization GET endpoint — a student may read their own authorization;
// admins/CAD may read any. Ownership is enforced inside the router
// (requireAuth + canViewAuthorization), never by trusting the client.
app.use('/api/v1/authorizations', authorizationRoutes);

// Receipt verification (public - receipt ID is the secret)
app.use('/api/v1/receipts', receiptRoutes);

// =====================================================
// AUTHENTICATED STUDENT ROUTES (authentication required)
// =====================================================

// Eligibility check - authenticated student checking their own eligibility
app.get('/api/v1/elections/:electionId/eligibility', (req, res, next) => {
  // For authenticated users, check their own eligibility
  // Student ID comes from session
  const studentId = req.user?.studentId;
  if (!studentId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required to check eligibility.',
      code: 'AUTH_REQUIRED',
    });
  }
  // Forward to eligibility check with session-based student ID
  req.params.studentId = studentId;
  authController.checkEligibility(req, res, next);
});

// Voting routes (authenticated, authorization checked separately)
app.use('/api/v1/elections', voteRoutes);

// Notifications (authenticated)
app.use('/api/v1/notifications', notificationRoutes);

// Support requests (authenticated)
app.use('/api/v1/support', supportRoutes);

// Photo uploads to Appwrite Storage (authenticated)
app.use('/api/v1/uploads', uploadsRoutes);

// Authenticated student's own profile (identity from session, never client-supplied)
// GET returns profile including Appwrite avatar URL (bucket: candidate-photos folder: profiles/)
// PATCH allows self-service name/phone/avatar update; avatar is an Appwrite Storage URL
app.get('/api/v1/students/profile', requireAuth, studentController.profile.bind(studentController));
app.patch('/api/v1/students/profile', requireAuth, studentController.updateProfile.bind(studentController));

// =====================================================
// ADMIN ROUTES (authentication + admin role required)
// =====================================================

// Admin routes with requireAdmin middleware (includes auth check + dev bypass for development)
app.use('/api/v1/admin/whitelist', requireAdmin, require('./routes/adminWhitelist'));
app.use('/api/v1/admin/students', requireAdmin, adminStudents);
app.use('/api/v1/admin/elections', requireAdmin, adminElections);
app.use('/api/v1/admin/positions', requireAdmin, adminPositions);
app.use('/api/v1/admin/constituencies', requireAdmin, adminConstituencyRoutes);
app.use('/api/v1/admin/candidates', requireAdmin, adminCandidates);
app.use('/api/v1/admin/candidate-applications', requireAdmin, adminCandidateAppRoutes);
app.use('/api/v1/admin/authorizations', requireAdmin, adminAuthorization);
app.use('/api/v1/admin/announcements', requireAdmin, adminAnnouncements);
app.use('/api/v1/admin/support', requireAdmin, adminSupport);
app.use('/api/v1/admin/email-recovery', requireAdmin, adminEmailRecoveryRoutes);
app.use('/api/v1/admin/access-requests', requireAdmin, adminAccessRequestRoutes);
app.use('/api/v1/admin/backups', requireAdmin, require('./routes/adminBackups'));
app.use('/api/v1/admin/stats', requireAdmin, adminStats.getStats);
app.get('/api/v1/admin/live', requireAdmin, adminLiveResults.getLive);
app.get('/api/v1/admin/audit-logs', requireAdmin, adminAuditLogs.list);

// System monitoring summary for the admin portal (aggregate, admin-only).
// Not a Prometheus scrape — the /metrics endpoint stays token-protected.
app.get('/api/v1/admin/monitoring', requireAdmin, async (req, res) => {
  try {
    const summary = await buildMonitoringSummary();
    res.json({ data: summary });
  } catch (err) {
    console.error('admin monitoring failed:', err.message);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Could not load monitoring summary.',
      code: 'INTERNAL_ERROR',
    });
  }
});

// Admin authorization management
app.get('/api/v1/admin/elections/:electionId/authorizations', requireAdmin, authController.list.bind(authController));
app.post('/api/v1/admin/elections/:electionId/authorizations', requireAdmin, authController.create.bind(authController));

// Admin-only: Election readiness check
app.get('/api/v1/admin/elections/:id/readiness', requireAdmin, (req, res, next) => {
  const ElectionController = require('./controllers/electionController');
  const controller = new ElectionController();
  controller.getReadiness.bind(controller)(req, res, next);
});

// CAD election-monitor routes (CAD or ADMIN role)
app.use('/api/v1/cad', cadRoutes);

// =====================================================
// 404 HANDLER
// =====================================================
app.use((req, res) => {
  // Only handle /api routes, let Next.js handle others
  if (req.path.startsWith('/api')) {
    res.status(404).json({
      error: 'Not Found',
      message: `Route ${req.method} ${req.path} not found.`,
      code: 'NOT_FOUND',
    });
  } else {
    // Let Next.js or other handlers deal with non-API routes
    res.status(404).json({
      error: 'Not Found',
      message: `Route ${req.method} ${req.path} not found.`,
      code: 'NOT_FOUND',
    });
  }
});

// =====================================================
// ERROR HANDLER
// =====================================================
app.use((err, req, res, next) => {
  // Log error
  console.error('Error:', err);

  // Don't expose internal errors in production
  const isDev = process.env.NODE_ENV !== 'production';

  // Handle specific error types
  if (err.name === 'SyntaxError' && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid JSON in request body.',
      code: 'INVALID_JSON',
    });
  }

  // Handle CORS errors
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Origin not allowed by CORS.',
      code: 'CORS_NOT_ALLOWED',
    });
  }

  // Default error response
  res.status(err.status || 500).json({
    error: err.status === 404 ? 'Not Found' : 'Internal Server Error',
    message: isDev ? err.message : (err.status >= 500 ? 'An internal server error occurred.' : err.message),
    code: err.code || 'INTERNAL_ERROR',
  });
});

module.exports = app;
