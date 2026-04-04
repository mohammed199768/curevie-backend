const { Pool } = require('pg');
const { logger } = require('../utils/logger');

const useConnectionString = Boolean(process.env.DATABASE_URL);
const sslEnabled = process.env.DB_SSL === 'true';

const poolConfig = useConnectionString
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'curevie',
      ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { message: err.message, stack: err.stack });
});

const { alertSlowQuery } = require('../utils/telegram');
const SLOW_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '2000', 10);
const _origQuery = pool.query.bind(pool);
pool.query = function(...args) {
  const start = Date.now();
  const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text || '');
  const result = _origQuery(...args);
  if (result && typeof result.then === 'function') {
    result.then(() => { const d = Date.now() - start; if (d >= SLOW_MS) alertSlowQuery(sql, d); }).catch(() => {});
  }
  return result;
};

module.exports = pool;
