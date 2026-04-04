const { alertStartup, alertShutdown } = require('./utils/telegram');
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const BACKEND_ROOT = path.resolve(__dirname);

const criticalDirs = [
  path.join(BACKEND_ROOT, 'logs'),
  path.join(BACKEND_ROOT, 'uploads'),
  path.join(BACKEND_ROOT, 'uploads', 'temp'),
  path.join(BACKEND_ROOT, 'uploads', 'pdfs'),
  path.join(BACKEND_ROOT, 'assets'),
];

criticalDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[INIT] Created directory: ${dir}`);
  }
});

if (process.cwd() !== BACKEND_ROOT) {
  console.warn(
    `[WARNING] Server started from: ${process.cwd()}\n` +
    `[WARNING] Backend root is:     ${BACKEND_ROOT}\n` +
    `[WARNING] Using __dirname-based paths to ensure correct file locations.`
  );
}

const app = require('./app');
const pool = require('./config/db');
const { logger } = require('./utils/logger');

const PORT = Number(process.env.PORT || 5000);

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection] at:', promise, 'reason:', reason);
});

const server = app.listen(PORT, async () => {
  try {
    await pool.query('SELECT 1');
    logger.info(`Server running on port ${PORT}`);
    alertStartup(PORT);
  } catch (err) {
    logger.error('PostgreSQL connection test failed on startup', { message: err.message });
    process.exit(1);
  }
});

const shutdown = async (signal) => {
  logger.info(`Received ${signal}, shutting down gracefully`);
  alertShutdown(signal);
  server.close(async () => {
    await pool.end();
    logger.info('HTTP server and DB pool closed');
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
