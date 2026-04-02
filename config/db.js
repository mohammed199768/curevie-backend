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

module.exports = pool;