/**
 * CampusVote Monitoring Module
 *
 * Prometheus-compatible observability for the Express backend, built on
 * `prom-client`. This module is deliberately additive and self-contained:
 *
 *   - It never changes authentication, voting, election, CSRF, session or
 *     database logic. The only hooks into those flows are a few guarded
 *     aggregate counter increments (votes cast, login attempts) that CANNOT
 *     affect the outcome — each increment is wrapped so a monitoring error
 *     is swallowed and never breaks the primary request.
 *   - It reuses the existing `pg` connection pool (no second pool) and only
 *     ever exposes aggregate counts. No student names, emails, roll numbers,
 *     session/OAuth/JWT identifiers, IP addresses, candidate selections or
 *     voter identities are ever exported as labels or values.
 *
 * Metric names follow the spec:
 *   campusvote_http_requests_total
 *   campusvote_http_request_duration_seconds
 *   campusvote_http_requests_active
 *   campusvote_http_errors_total
 *   campusvote_votes_cast_total
 *   campusvote_login_attempts_total
 *   campusvote_failed_login_attempts_total
 *   campusvote_active_elections
 *   campusvote_registered_students_total
 *   campusvote_candidate_applications_total
 *   campusvote_database_connections_total
 *   campusvote_database_connections_idle
 *   campusvote_database_connections_waiting
 *
 * Plus the standard Node.js collector metrics (process CPU/memory, heap,
 * event loop lag, uptime) via prom-client's collectDefaultMetrics().
 *
 * In-process plain-number aggregates (the `stats` object) mirror the
 * prometheus counters in order to feed the admin monitoring summary without
 * depending on prom-client's value-reading API, which changed across majors.
 */

const client = require('prom-client');
const crypto = require('node:crypto');
const { getDb: getSharedDb } = require('../db/mongoClient');

// ---------------------------------------------------------------------------
// Registry + default Node metrics (idempotent init)
// ---------------------------------------------------------------------------

const register = new client.Registry();

let defaultMetricsStarted = false;
function ensureDefaultMetrics() {
  if (defaultMetricsStarted) return;
  defaultMetricsStarted = true;
  client.collectDefaultMetrics({ register });
}
ensureDefaultMetrics();

// ---------------------------------------------------------------------------
// HTTP request metrics
// ---------------------------------------------------------------------------

const httpRequestsTotal = new client.Counter({
  name: 'campusvote_http_requests_total',
  help: 'Total number of HTTP requests handled by CampusVote.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'campusvote_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsActive = new client.Gauge({
  name: 'campusvote_http_requests_active',
  help: 'Number of HTTP requests currently being processed.',
  registers: [register],
});

const httpErrorsTotal = new client.Counter({
  name: 'campusvote_http_errors_total',
  help: 'Total number of HTTP responses with status >= 500. Aggregated counts only.',
  labelNames: ['method', 'route'],
  registers: [register],
});

// ---------------------------------------------------------------------------
// CampusVote business + database metrics
// ---------------------------------------------------------------------------

const votesCastTotal = new client.Counter({
  name: 'campusvote_votes_cast_total',
  help: 'Total number of successfully cast votes.',
  registers: [register],
});

const loginAttemptsTotal = new client.Counter({
  name: 'campusvote_login_attempts_total',
  help: 'Total number of login attempts (successful or not).',
  registers: [register],
});

const failedLoginAttemptsTotal = new client.Counter({
  name: 'campusvote_failed_login_attempts_total',
  help: 'Total number of failed login attempts.',
  registers: [register],
});

const activeElections = new client.Gauge({
  name: 'campusvote_active_elections',
  help: 'Number of elections currently OPEN.',
  registers: [register],
});

const registeredStudentsTotal = new client.Gauge({
  name: 'campusvote_registered_students_total',
  help: 'Total number of registered student accounts.',
  registers: [register],
});

const candidateApplicationsTotal = new client.Gauge({
  name: 'campusvote_candidate_applications_total',
  help: 'Total number of candidate applications received.',
  registers: [register],
});

// Database pool gauges — reuses the existing pg Pool, never a second pool.
const dbConnectionsTotal = new client.Gauge({
  name: 'campusvote_database_connections_total',
  help: 'Current number of database connections in the pool.',
  registers: [register],
});

const dbConnectionsIdle = new client.Gauge({
  name: 'campusvote_database_connections_idle',
  help: 'Current number of idle database connections in the pool.',
  registers: [register],
});

const dbConnectionsWaiting = new client.Gauge({
  name: 'campusvote_database_connections_waiting',
  help: 'Current number of requests waiting for a database connection.',
  registers: [register],
});

// ---------------------------------------------------------------------------
// In-process aggregates (mirror the prometheus counters for the summary)
// ---------------------------------------------------------------------------

const stats = {
  requestsTotal: 0,
  requestActive: 0,
  errorCount: 0,
  durationSumMs: 0,
  durationCount: 0,
  votesCast: 0,
  loginAttempts: 0,
  failedLogins: 0,
};

// ---------------------------------------------------------------------------
// Route normalization (low cardinality label values)
// ---------------------------------------------------------------------------

/**
 * Normalize a request path into a low-cardinality route template.
 *
 * Prefer the matched Express route pattern (e.g. `/api/v1/students/:id`).
 * When no route matched (404s), fall back to a coarse-grained template based
 * on the leading path segments so raw IDs never become label values.
 */
function normalizeRoute(req, fallback = 'unmatched') {
  const routePath = req.route?.path;
  if (routePath) {
    const full = `${req.baseUrl || ''}${routePath}` || req.path;
    return full.replace(/:\w+/g, ':id').replace(/\/\d+/g, '/:id') || fallback;
  }
  const segments = (req.path || '').split('/').filter(Boolean);
  const template = segments
    .slice(0, 4)
    .map((seg) => (/^\d+$/.test(seg) ? ':id' : seg))
    .join('/');
  return template ? `/${template}` : fallback;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that measures every request (except the /metrics scrape
 * itself) and records aggregate counters, duration histogram and the active
 * request gauge. Uses res.on('finish') so failures are also measured.
 */
function httpMetricsMiddleware(req, res, next) {
  if (req.path === '/metrics') return next();

  const start = process.hrtime.bigint();
  const method = req.method;
  httpRequestsActive.inc();
  stats.requestActive += 1;

  res.on('finish', () => {
    const statusCode = String(res.statusCode || 0);
    const route = normalizeRoute(req);
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    // Prometheus exposition
    httpRequestsTotal.labels(method, route, statusCode).inc();
    httpRequestDuration.labels(method, route, statusCode).observe(durationMs / 1000);
    if (res.statusCode >= 500) httpErrorsTotal.labels(method, route).inc();

    // In-process aggregates
    stats.requestsTotal += 1;
    stats.durationSumMs += durationMs;
    stats.durationCount += 1;
    if (res.statusCode >= 500) stats.errorCount += 1;
    stats.requestActive = Math.max(0, stats.requestActive - 1);

    httpRequestsActive.dec();
  });

  next();
}

// ---------------------------------------------------------------------------
// Refresh helpers (lazy DB access — reuse the single existing pool)
// ---------------------------------------------------------------------------

async function refreshDbMetrics() {
  try {
    const { pool } = require('../db');
    dbConnectionsTotal.set(pool.totalCount || 0);
    dbConnectionsIdle.set(pool.idleCount || 0);
    dbConnectionsWaiting.set(pool.waitingCount || 0);
  } catch (err) {
    // Metrics must never break the scrape/read path.
  }
}

async function refreshBusinessMetrics() {
  const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);
  if (isMongoOnly) {
    try {
      const db = await getSharedDb();
      if (db) {
        const [electionsCount, studentsCount, appsCount] = await Promise.all([
          db.collection('elections').countDocuments({ status: 'OPEN' }).catch(() => 0),
          db.collection(process.env.MONGODB_STUDENTS_COLLECTION || 'students').countDocuments({ $or: [{ role: 'STUDENT' }, { role: { $exists: false } }] }).catch(() => 0),
          db.collection('candidate_applications').countDocuments({}).catch(() => 0),
        ]);
        activeElections.set(electionsCount || 0);
        registeredStudentsTotal.set(studentsCount || 0);
        candidateApplicationsTotal.set(appsCount || 0);
        return;
      }
    } catch (e) {
      // Swallow — fall through to zero
    }
    activeElections.set(0);
    registeredStudentsTotal.set(0);
    candidateApplicationsTotal.set(0);
    return;
  }
  try {
    const { query } = require('../db');
    const [elections, students, applications] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM elections WHERE status = 'OPEN'`),
      query(`SELECT COUNT(*)::int AS total FROM students WHERE role = 'STUDENT'`),
      query(`SELECT COUNT(*)::int AS total FROM candidate_applications`),
    ]);
    activeElections.set(elections.rows[0].total || 0);
    registeredStudentsTotal.set(students.rows[0].total || 0);
    candidateApplicationsTotal.set(applications.rows[0].total || 0);
  } catch (err) {
    // Swallow — DB health is reported separately via /health/db.
  }
}

// ---------------------------------------------------------------------------
// Guarded counter increments (used inside the existing auth/vote flows)
// ---------------------------------------------------------------------------

function incVotesCast() {
  try {
    votesCastTotal.inc();
    stats.votesCast += 1;
  } catch (err) {
    /* never break voting */
  }
}

function incLoginAttempt() {
  try {
    loginAttemptsTotal.inc();
    stats.loginAttempts += 1;
  } catch (err) {
    /* never break login */
  }
}

function incFailedLogin() {
  try {
    failedLoginAttemptsTotal.inc();
    stats.failedLogins += 1;
  } catch (err) {
    /* never break login */
  }
}

// ---------------------------------------------------------------------------
// Metrics endpoint protection
// ---------------------------------------------------------------------------

function metricsTokenConfigured() {
  return typeof process.env.METRICS_TOKEN === 'string' && process.env.METRICS_TOKEN.length >= 16;
}

function timingSafeEqualStrings(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Protected GET /metrics handler.
 *
 * Security model (safe default for Render free tier):
 *   - If METRICS_TOKEN is configured, the caller MUST present it via the
 *     `Authorization: Bearer <token>` header. Comparison is timing-safe.
 *   - If METRICS_TOKEN is NOT configured:
 *       * production  -> 403 (metrics intentionally disabled rather than
 *                           accidentally exposed to the public internet)
 *       * non-prod    -> open access (local development convenience only)
 *
 * Data exposed here is aggregate-only; no secrets, connection strings,
 * sessions or personal data are exported.
 */
function metricsHandler(req, res) {
  const configured = metricsTokenConfigured();

  if (configured) {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match || !timingSafeEqualStrings(match[1], process.env.METRICS_TOKEN)) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'A valid metrics token is required.',
        code: 'METRICS_TOKEN_REQUIRED',
      });
    }
  } else {
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Metrics are disabled. Set METRICS_TOKEN to enable them.',
        code: 'METRICS_DISABLED',
      });
    }
  }

  Promise.all([refreshBusinessMetrics(), refreshDbMetrics()])
    .then(() => register.metrics())
    .then((body) => {
      res.set('Content-Type', register.contentType);
      res.send(body);
    })
    .catch(() => {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Could not render metrics.',
        code: 'METRICS_ERROR',
      });
    });
}

// ---------------------------------------------------------------------------
// Admin monitoring summary (aggregate, safe JSON for the frontend)
// ---------------------------------------------------------------------------

/** Rolling samples used to derive rates (requests/sec, CPU %) between reads. */
const samples = {
  lastRequestsTotal: 0,
  lastRequestsAt: null,
  lastCpuSeconds: null,
  lastCpuAt: null,
};

/**
 * Read a metric's current value. prom-client v15 exposes values on the
 * metric's internal hashMap (no-label gauges use the '' key); `.get()` is
 * not a stable read API across major versions, so we go straight to hashMap.
 */
function readGauge(name) {
  try {
    const metric = register.getSingleMetric(name);
    if (!metric?.hashMap) return 0;
    const keys = Object.keys(metric.hashMap);
    if (keys.length === 0) return 0;
    const value = metric.hashMap[keys[0]]?.value;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Build a safe, aggregate monitoring summary for /api/v1/admin/monitoring.
 * No personal data, no secrets, no connection strings.
 */
async function buildMonitoringSummary() {
  let dbConnected = false;
  const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);
  if (isMongoOnly) {
    try {
      const db = await getSharedDb();
      if (db) {
        await db.command({ ping: 1 });
        dbConnected = true;
      } else {
        dbConnected = false;
      }
    } catch (err) {
      dbConnected = false;
    }
  } else {
    try {
      const { pool } = require('../db');
      await pool.query('SELECT 1');
      dbConnected = true;
    } catch (err) {
      dbConnected = false;
    }
  }

  await refreshDbMetrics();
  await refreshBusinessMetrics();

  const now = Date.now();

  // Requests/sec since the previous read.
  let requestsPerSecond = 0;
  if (samples.lastRequestsAt !== null) {
    const dtSec = (now - samples.lastRequestsAt) / 1000;
    const delta = stats.requestsTotal - samples.lastRequestsTotal;
    if (dtSec > 0 && delta >= 0) requestsPerSecond = Math.round((delta / dtSec) * 10) / 10;
  }
  samples.lastRequestsAt = now;
  samples.lastRequestsTotal = stats.requestsTotal;

  // CPU % (default-collector user+system seconds delta over wall time).
  let cpuPercent = null;
  const cpuUser = Number(readGauge('process_cpu_user_seconds_total') || 0);
  const cpuSystem = Number(readGauge('process_cpu_system_seconds_total') || 0);
  const cpuTotal = cpuUser + cpuSystem;
  if (samples.lastCpuAt !== null && samples.lastCpuSeconds !== null) {
    const dtSec = (now - samples.lastCpuAt) / 1000;
    if (dtSec > 0) {
      cpuPercent = Math.min(100, Math.round(((cpuTotal - samples.lastCpuSeconds) / dtSec) * 1000) / 10);
    }
  }
  samples.lastCpuAt = now;
  samples.lastCpuSeconds = cpuTotal;

  const heapUsedBytes = Number(readGauge('nodejs_heap_size_used_bytes') || 0);
  const heapTotalBytes = Number(readGauge('nodejs_heap_size_total_bytes') || 0);
  const memoryRssBytes = Number(readGauge('process_resident_memory_bytes') || 0);
  const startTimeSec = Number(readGauge('process_start_time_seconds') || 0);
  const uptimeSeconds =
    startTimeSec > 0 ? Math.max(0, Math.floor(now / 1000 - startTimeSec)) : Math.floor(process.uptime());

  const avgDurationMs =
    stats.durationCount > 0 ? Math.round((stats.durationSumMs / stats.durationCount) * 10) / 10 : 0;

  // Status: database reachability + error-rate based.
  const errorRate = stats.requestsTotal > 0 ? stats.errorCount / stats.requestsTotal : 0;
  let status = 'degraded';
  if (dbConnected) status = errorRate < 0.10 ? 'healthy' : 'degraded';

  return {
    status,
    generatedAt: new Date().toISOString(),
    metricsEnabled: metricsTokenConfigured(),
    uptimeSeconds,
    nodeVersion: process.version,
    process: {
      cpuPercent,
      memoryRssBytes,
      heapUsedBytes,
      heapTotalBytes,
    },
    http: {
      requestsTotal: stats.requestsTotal,
      requestsPerSecond,
      active: Math.max(0, stats.requestActive),
      averageDurationMs: avgDurationMs,
      samples: stats.durationCount,
      errorCount: stats.errorCount,
      errorRatePct: stats.requestsTotal > 0 ? Math.round((stats.errorCount / stats.requestsTotal) * 10000) / 100 : 0,
    },
    database: {
      connected: dbConnected,
      total: Number(readGauge('campusvote_database_connections_total') || 0),
      idle: Number(readGauge('campusvote_database_connections_idle') || 0),
      waiting: Number(readGauge('campusvote_database_connections_waiting') || 0),
    },
    business: {
      activeElections: Number(readGauge('campusvote_active_elections') || 0),
      registeredStudents: Number(readGauge('campusvote_registered_students_total') || 0),
      votesCast: stats.votesCast,
      candidateApplications: Number(readGauge('campusvote_candidate_applications_total') || 0),
      loginAttempts: stats.loginAttempts,
      failedLogins: stats.failedLogins,
    },
  };
}

module.exports = {
  register,
  ensureDefaultMetrics,
  httpMetricsMiddleware,
  metricsHandler,
  buildMonitoringSummary,
  incVotesCast,
  incLoginAttempt,
  incFailedLogin,
  metricsTokenConfigured,
};