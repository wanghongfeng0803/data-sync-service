const path = require('node:path');

const env = process.env;

function int(name, fallback) {
  const value = Number.parseInt(env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

const root = process.cwd();

module.exports = {
  port: int('PORT', 3000),
  nodeEnv: env.NODE_ENV || 'development',
  db: {
    path: env.DB_PATH || path.join(root, 'data', 'sync.db'),
  },
  sync: {
    concurrency: int('SYNC_CONCURRENCY', 4),
    scanIntervalMs: int('SYNC_SCAN_INTERVAL_MS', 5000),
    defaultMaxAttempts: int('SYNC_DEFAULT_MAX_ATTEMPTS', 5),
    backoffBaseMs: int('SYNC_BACKOFF_BASE_MS', 1000),
    backoffFactor: Number.parseFloat(env.SYNC_BACKOFF_FACTOR || '2'),
    backoffMaxMs: int('SYNC_BACKOFF_MAX_MS', 5 * 60 * 1000),
  },
  transform: {
    workers: int('TRANSFORM_WORKERS', 2),
  },
  connector: {
    httpTimeoutMs: int('HTTP_CONNECTOR_TIMEOUT_MS', 15000),
  },
  logLevel: env.LOG_LEVEL || 'info',
};
