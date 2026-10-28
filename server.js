require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const { alertStartup, alertShutdown } = require('./utils/telegram');

const BACKEND_ROOT = path.resolve(__dirname);
['logs', 'uploads', path.join('uploads', 'private')].forEach((dir) => {
  fs.mkdirSync(path.join(BACKEND_ROOT, dir), { recursive: true });
});

const app = require('./app');
const pool = require('./config/db');
const { logger } = require('./utils/logger');
const { initSocketServer } = require('./utils/socket');

const PORT = Number(process.env.PORT || 5000);

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});

const server = http.createServer(app);
initSocketServer(server);

server.listen(PORT, async () => {
  try {
    await pool.query('SELECT 1');
    logger.info(`Server running on port ${PORT}`);
    alertStartup(PORT);
  } catch (err) {
    logger.error('PostgreSQL connection test failed on startup', { message: err.message });
    process.exit(1);
  }
});

const shutdown = (signal) => {
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
