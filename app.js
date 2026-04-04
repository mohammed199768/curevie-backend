const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser'); // FIX: F13 — parse httpOnly auth cookies before the auth routes run.
const morgan = require('morgan');
const compression = require('compression');
require('dotenv').config();

const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');
const cultureRoutes = require('./modules/culture/culture.routes');
const filesRoutes = require('./modules/files/files.routes');
const pool = require('./config/db');
const redisCache = require('./utils/cache');

const app = express();
app.set('trust proxy', 1);

// =============================================
// HELMET - متقدم
// =============================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameSrc:   ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy:   { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  dnsPrefetchControl:        { allow: false },
  frameguard:                { action: 'deny' },
  hsts: {
    maxAge:            31536000,
    includeSubDomains: true,
    preload:           true,
  },
  ieNoOpen:        true,
  noSniff:         true,
  referrerPolicy:  { policy: 'strict-origin-when-cross-origin' },
  xssFilter:       true,
}));

// =============================================
// CORS - explicit allowed origins
// =============================================
const PRODUCTION_ORIGINS = [
  'https://curevie.net',
  'https://www.curevie.net',
  'https://admin.curevie.net',
  'https://provider.curevie.net',
];

const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
];

const allowedOrigins = process.env.NODE_ENV === 'production'
  ? PRODUCTION_ORIGINS
  : [...PRODUCTION_ORIGINS, ...DEV_ORIGINS];

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Allow Vercel preview deployments
    if (origin.match(/^https:\/\/curevie.*\.vercel\.app$/)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Auth-Role',
    'X-Requested-With',
  ],
}));

// =============================================
// MIDDLEWARE
// =============================================
app.use(compression({ threshold: 1024 }));   // ← أول شي
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser()); // FIX: F13 — expose req.cookies for cookie-backed refresh and logout endpoints.
// AUDIT-FIX: PATH — use __dirname so static uploads resolve inside backend/
app.use('/uploads', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// =============================================
// ROUTES
// =============================================
app.use('/api/v1/auth',          require('./modules/admin/auth.routes'));
app.use('/api/v1/patients',      require('./modules/patients/patient.routes'));
app.use('/api/v1/providers',     require('./modules/providers/provider.routes'));
app.use('/api/v1/services',      require('./modules/services/service.routes'));
app.use('/api/v1/lab',           require('./modules/labtests/labtest.routes'));
app.use('/api/v1/lab-results/:labResultId/culture', cultureRoutes);
app.use('/api/v1/requests',      require('./modules/requests/request.routes'));
app.use('/api/v1/analytics',     require('./modules/analytics/analytics.routes'));
app.use('/api/v1/invoices',      require('./modules/invoices/invoice.routes'));
app.use('/api/v1/chat',          require('./modules/chat/chat.routes'));
app.use('/api/v1/files',         filesRoutes);
app.use('/api/v1/payments',      require('./modules/payments/payment.routes'));
app.use('/api/v1/contact',       require('./modules/contact/contact.routes'));
app.use('/api/v1/notifications', require('./modules/notifications/notification.routes'));
app.use('/api/v1/reports',       require('./modules/reports/report.routes'));

// =============================================
// HEALTH CHECK
// =============================================
async function healthHandler(req, res) {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    services: {},
  };

  try {
    await pool.query('SELECT 1');
    health.services.postgres = 'ok';
  } catch (err) {
    health.services.postgres = 'error';
    health.status = 'degraded';
  }

  try {
    if (redisCache && typeof redisCache.ping === 'function') {
      const result = await redisCache.ping();
      if (result === 'PONG') {
        health.services.redis = 'ok';
      } else {
        health.services.redis = 'error';
        health.status = 'degraded';
      }
    } else {
      health.services.redis = 'not configured';
    }
  } catch (err) {
    health.services.redis = 'error';
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
}

app.get('/health', healthHandler);
app.get('/api/v1/health', healthHandler);

// =============================================
// 404 & ERROR HANDLER
// =============================================
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
