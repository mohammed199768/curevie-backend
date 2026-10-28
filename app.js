require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const compression = require('compression');

const { errorHandler, notFoundHandler, AppError } = require('./middlewares/errorHandler');
const { isOriginAllowed } = require('./config/cors');
const pool = require('./config/db');
const redisCache = require('./utils/cache');
const { PUBLIC_ROOT, PUBLIC_MEDIA_ROUTE } = require('./utils/storage');

const app = express();

// One proxy hop (our nginx) sits in front of the app; req.ip is the real client address.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
}));

// Public images (avatars, catalog). File names are random UUIDs and never reused, so they can be
// cached forever. Private medical files live elsewhere and are only streamed after access checks.
app.use(PUBLIC_MEDIA_ROUTE, express.static(PUBLIC_ROOT, {
  dotfiles: 'deny',
  index: false,
  redirect: false,
  immutable: true,
  maxAge: '365d',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

app.use(cors({
  origin: (origin, callback) => {
    // Requests without an Origin header (server-to-server, curl, mobile apps) are not CORS requests.
    if (!origin || isOriginAllowed(origin)) return callback(null, true);
    return callback(new AppError('Origin not allowed', 403, 'CORS_BLOCKED'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Auth-Role', 'X-Requested-With'],
  // Lets the frontends read the download file name of PDFs / attachments.
  exposedHeaders: ['Content-Disposition'],
}));

app.use(compression({ threshold: 1024 }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(cookieParser());

// =============================================
// ROUTES
// =============================================
app.use('/api/v1/auth', require('./modules/admin/auth.routes'));
app.use('/api/v1/patients', require('./modules/patients/patient.routes'));
app.use('/api/v1/providers', require('./modules/providers/provider.routes'));
app.use('/api/v1/areas', require('./modules/areas/area.routes'));
app.use('/api/v1/services', require('./modules/services/service.routes'));
app.use('/api/v1/packages', require('./modules/packages/package.routes'));
app.use('/api/v1/cases', require('./modules/cases/case.routes'));
app.use('/api/v1/analytics', require('./modules/analytics/analytics.routes'));
app.use('/api/v1/contact', require('./modules/contact/contact.routes'));
app.use('/api/v1/notifications', require('./modules/notifications/notification.routes'));
app.use('/api/v1/reports', require('./modules/reports/report.routes'));

// =============================================
// HEALTH CHECK
// =============================================
async function healthHandler(req, res) {
  const health = { status: 'ok', timestamp: new Date().toISOString(), services: {} };

  try {
    await pool.query('SELECT 1');
    health.services.postgres = 'ok';
  } catch (_) {
    health.services.postgres = 'error';
    health.status = 'degraded';
  }

  try {
    health.services.redis = (await redisCache.ping()) === 'PONG' ? 'ok' : 'error';
  } catch (_) {
    health.services.redis = 'error';
  }
  if (health.services.redis !== 'ok') health.status = 'degraded';

  res.status(health.status === 'ok' ? 200 : 503).json(health);
}

app.get('/health', healthHandler);
app.get('/api/v1/health', healthHandler);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
