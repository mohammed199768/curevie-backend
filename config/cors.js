// Single source of truth for allowed browser origins (Express CORS and Socket.io).
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

// Exact extra origins (for example a specific Vercel preview), comma separated.
const EXTRA_ORIGINS = String(process.env.CORS_EXTRA_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter((origin) => /^https?:\/\/[^\s/]+$/i.test(origin));

const allowedOrigins = new Set([
  ...PRODUCTION_ORIGINS,
  ...EXTRA_ORIGINS,
  ...(process.env.NODE_ENV === 'production' ? [] : DEV_ORIGINS),
]);

function isOriginAllowed(origin) {
  return allowedOrigins.has(String(origin || '').replace(/\/+$/, ''));
}

module.exports = { allowedOrigins: [...allowedOrigins], isOriginAllowed };
