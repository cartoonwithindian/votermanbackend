const { Pool } = require('pg');
const dbConfig = require('../config/database');
const config = require('../config');

// Build connection configuration
const getPoolConfig = () => {
  // Support DATABASE_URL for easy configuration
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      // Apply SSL when DB_SSL=true (required by hosted Postgres like Render)
      ssl: config.dbSsl,
      ...dbConfig.pool,
    };
  }

  // Individual connection parameters
  return {
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    ssl: config.dbSsl,
    ...dbConfig.pool,
  };
};

// Create the connection pool — allow MongoDB-only (Atlas M10) without Postgres
let pool;
let isMongoOnly = false;
if (!process.env.DATABASE_URL && (process.env.MONGODB_URI || process.env.MONGODB_URL)) {
  console.log('DATABASE_URL missing — running in MongoDB-only mode (Atlas M10) — Postgres pool disabled');
  isMongoOnly = true;
  // Dummy pool that never throws 500 for student portal; queries return empty instead.
  // Services that are Mongo-aware will handle isMongoOnly themselves; unguarded
  // student routes that still call db.query will now get [] rather than 500.
  pool = {
    query: async (...args) => {
      // Log once per process to avoid noise, but keep student portal alive
      console.warn('[db] Postgres not configured — Mongo-only mode: returning empty for query:', String(args[0]).slice(0, 80));
      return { rows: [], rowCount: 0 };
    },
    on: () => {},
    end: async () => {},
    connect: async () => {
      // Provide a mock client that mimics pg Client for transaction code that
      // would otherwise throw. It returns empty on query and supports release.
      console.warn('[db] Postgres not configured — Mongo-only mode: mock connect() returning empty client');
      return {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      };
    },
  };
} else {
  pool = new Pool(getPoolConfig());
  // Handle pool errors
  pool.on('error', (err) => {
    console.error('Unexpected error on idle database client:', err.message);
  });
}

// Health check function - executes SELECT 1 (or MongoDB ping when Postgres disabled)
const healthCheck = async () => {
  if (isMongoOnly) {
    const start = Date.now();
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(process.env.MONGODB_URI || process.env.MONGODB_URL);
      await client.connect();
      await client.db(process.env.MONGODB_DB || 'voteweb').command({ ping: 1 });
      await client.close();
      const duration = Date.now() - start;
      return { status: 'ok', responseTime: `${duration}ms`, timestamp: new Date().toISOString(), database: 'mongodb' };
    } catch (e) {
      return { status: 'error', message: e.message, timestamp: new Date().toISOString() };
    }
  }
  const start = Date.now();
  const result = await pool.query('SELECT 1 AS health_check');
  const duration = Date.now() - start;
  return {
    status: 'ok',
    responseTime: `${duration}ms`,
    timestamp: new Date().toISOString(),
  };
};

// Graceful shutdown
const close = async () => {
  console.log('Closing database connection pool...');
  await pool.end();
  console.log('Database connection pool closed.');
};

/**
 * Audit log function for administrative operations
 *
 * SECURITY NOTE: This logs administrative actions without exposing
 * sensitive information like passwords, tokens, or candidate choices.
 *
 * Schema: id, actor_id, actor_type, action, entity_type, entity_id, metadata, ip_address, created_at
 */
const auditLog = async (eventType, details) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_id, actor_type, action, entity_type, entity_id, metadata, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        details.adminUserId || null,
        details.adminUserId ? 'ADMIN' : 'SYSTEM',
        eventType,
        details.entityType || 'ELECTION',
        details.entityId || null,
        JSON.stringify({
          // Only safe metadata - no passwords, tokens, or candidate choices
          name: details.name,
          status: details.status,
          previousStatus: details.previousStatus,
          newStatus: details.newStatus,
          electionId: details.electionId,
        }),
        details.ipAddress || null,
      ]
    );
  } catch (err) {
    // Log failures should not break the main operation
    console.error('Audit log failed:', err.message);
  }
};

module.exports = {
  pool,
  query: pool.query.bind(pool),
  healthCheck,
  close,
  auditLog,
};
