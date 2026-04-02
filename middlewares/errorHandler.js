const { logger } = require('../utils/logger');

// Custom error class
class AppError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Common errors factory
const Errors = {
  notFound: (resource = 'Resource') => new AppError(`${resource} not found`, 404, 'NOT_FOUND'),
  unauthorized: (msg = 'Unauthorized') => new AppError(msg, 401, 'UNAUTHORIZED'),
  forbidden: (msg = 'Access denied') => new AppError(msg, 403, 'FORBIDDEN'),
  badRequest: (msg) => new AppError(msg, 400, 'BAD_REQUEST'),
  conflict: (msg) => new AppError(msg, 409, 'CONFLICT'),
  internal: (msg = 'Internal server error') => new AppError(msg, 500, 'INTERNAL'),
};

// Central error handler — must have 4 params for Express to recognize it
const errorHandler = (err, req, res, next) => {
  // Operational errors (our AppError)
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      message: err.message,
      code: err.code,
    });
  }

  // PostgreSQL errors
  if (err.code === '23505') {
    return res.status(409).json({ message: 'Duplicate entry — this record already exists.', code: 'DUPLICATE' });
  }
  if (err.code === '23503') {
    return res.status(400).json({ message: 'Referenced record does not exist.', code: 'FOREIGN_KEY', constraint: err.constraint, detail: err.detail });
  }
  if (err.code === '22P02') {
    return res.status(400).json({ message: 'Invalid ID format.', code: 'INVALID_UUID' });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ message: 'Invalid token.', code: 'INVALID_TOKEN' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ message: 'Token expired.', code: 'TOKEN_EXPIRED' });
  }

  // Unknown errors — log full details but return generic message
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id,
    ip: req.ip,
  });

  res.status(500).json({
    message: process.env.NODE_ENV === 'production'
      ? 'Something went wrong. Please try again later.'
      : err.message,
    code: 'INTERNAL_ERROR',
  });
};

// 404 handler
const notFoundHandler = (req, res) => {
  logger.warn('Route not found', { path: req.path, method: req.method, ip: req.ip });
  res.status(404).json({ message: `Route ${req.method} ${req.path} not found`, code: 'ROUTE_NOT_FOUND' });
};

module.exports = { AppError, Errors, errorHandler, notFoundHandler };
