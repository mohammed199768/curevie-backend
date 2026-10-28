const { alertError } = require('../utils/telegram');
const { logger } = require('../utils/logger');

class AppError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Known errors that are the client's fault: answered without details and without alerting.
const POSTGRES_ERRORS = {
  23505: [409, 'DUPLICATE', 'This record already exists.'],
  23503: [409, 'REFERENCE_CONFLICT', 'The operation conflicts with related records (missing reference or record in use).'],
  23514: [400, 'CONSTRAINT_VIOLATION', 'The data violates a validation rule.'],
  '22P02': [400, 'INVALID_INPUT', 'Invalid input format.'],
  '22007': [400, 'INVALID_INPUT', 'Invalid date format.'],
  '22008': [400, 'INVALID_INPUT', 'Date out of range.'],
};

const errorHandler = (err, req, res, next) => {
  if (err.isOperational) {
    return res.status(err.statusCode).json({ message: err.message, code: err.code });
  }

  const pgError = POSTGRES_ERRORS[err.code];
  if (pgError) {
    const [status, code, message] = pgError;
    logger.warn('Database constraint error', { code: err.code, constraint: err.constraint, path: req.path });
    return res.status(status).json({ message, code });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Malformed JSON body', code: 'INVALID_JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
  }

  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id,
    ip: req.ip,
  });

  alertError(err, req);
  return res.status(500).json({
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong. Please try again later.' : err.message,
    code: 'INTERNAL_ERROR',
  });
};

const notFoundHandler = (req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} not found`, code: 'ROUTE_NOT_FOUND' });
};

module.exports = { AppError, errorHandler, notFoundHandler };
