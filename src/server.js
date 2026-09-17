require('dotenv').config();
const app = require('./app');
const config = require('./config');
const db = require('./db');

const PORT = config.port || 3000;

/**
 * Run pending migrations before accepting traffic.
 *
 * Why: the deploy pipeline's preDeploy migration step is not guaranteed on
 * every host, and a schema/app mismatch crash-loops the service. Running the
 * migration runner at boot makes the schema a precondition of serving, and
 * the runner is idempotent (tracks applied migrations by name in the
 * `migrations` table), so this is a no-op when the schema is current.
 */
async function startServer() {
  try {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('node', ['migrate.js', 'up'], {
      cwd: require('path').join(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) {
      throw new Error(`migrations failed with exit code ${result.status}`);
    }
  } catch (err) {
    console.error('FATAL: migration step failed — refusing to start:', err.message);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`VoteWeb API server running on port ${PORT}`);
    console.log(`Environment: ${config.env}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log(`Database health: http://localhost:${PORT}/api/health/db`);
  });

  // Scheduled DB snapshot backups to Appwrite Storage (no-op when not
  // configured). See src/services/backupScheduler.js.
  require('./services/backupScheduler').start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nReceived shutdown signal...');

    server.close(async () => {
      console.log('HTTP server closed.');

      try {
        await db.close();
        console.log('Graceful shutdown complete.');
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err.message);
        process.exit(1);
      }
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer();
