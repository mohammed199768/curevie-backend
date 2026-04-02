const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

// AUDIT-FIX: PATH — use __dirname so log paths resolve correctly
// regardless of which directory `node` is started from.
// __dirname = backend/utils → BACKEND_ROOT = backend/
const BACKEND_ROOT = path.join(__dirname, '..');
const logDir = path.join(BACKEND_ROOT, 'logs');

// Log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

// Format for console
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

// Format for files (no colors)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Rotating file transport — errors
const errorFileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logDir, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  maxFiles: '30d',
  maxSize: '20m',
  format: fileFormat,
});

// Rotating file transport — all logs
const combinedFileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logDir, 'combined-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m',
  format: fileFormat,
});

// Rotating file transport — security/audit events
const auditFileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logDir, 'audit-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '90d', // Keep audit logs 90 days
  maxSize: '20m',
  format: fileFormat,
});

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  levels,
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    errorFileTransport,
    combinedFileTransport,
  ],
});

// Separate audit logger
const auditLogger = winston.createLogger({
  levels,
  transports: [auditFileTransport],
  format: fileFormat,
});

// Audit log helper - tracks sensitive actions
const audit = (action, { userId, role, targetId, targetType, ip, details } = {}) => {
  auditLogger.info(action, {
    userId,
    role,
    targetId,
    targetType,
    ip,
    details,
    timestamp: new Date().toISOString(),
  });
};

// HTTP request logger for morgan
const httpLogger = (tokens, req, res) => {
  const log = [
    tokens.method(req, res),
    tokens.url(req, res),
    tokens.status(req, res),
    tokens.res(req, res, 'content-length'), '-',
    tokens['response-time'](req, res), 'ms',
    `[${req.ip}]`,
    req.user ? `[user:${req.user.id}]` : '[guest]',
  ].join(' ');

  const status = parseInt(tokens.status(req, res));
  if (status >= 500) logger.error(log);
  else if (status >= 400) logger.warn(log);
  else logger.http(log);

  return null; // Morgan needs null return to not log itself
};

module.exports = { logger, audit, httpLogger };
