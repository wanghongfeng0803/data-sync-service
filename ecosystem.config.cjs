module.exports = {
  apps: [
    {
      name: 'data-sync-service',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        DB_PATH: 'data/sync.db',
        SYNC_CONCURRENCY: 4,
        TRANSFORM_WORKERS: 2,
        LOG_LEVEL: 'info',
      },
      kill_signal: 'SIGTERM',
      kill_timeout: 20000,
      max_memory_restart: '400M',
    },
  ],
};
