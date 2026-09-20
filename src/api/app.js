const express = require('express');
const logger = require('../utils/logger');
const { HttpError } = require('./errors');
const { createSystemRouter } = require('./routes/system');
const { createJobsRouter } = require('./routes/jobs');

function createApp(deps) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.debug('http request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  app.get('/', (_req, res) => {
    res.json({
      service: 'data-sync-service',
      version: '1.0.0',
      endpoints: [
        'GET /api/v1/health',
        'POST /api/v1/jobs',
        'GET /api/v1/jobs',
        'GET /api/v1/jobs/:id',
        'GET /api/v1/jobs/:id/items',
        'POST /api/v1/jobs/:id/cancel',
        'POST /api/v1/jobs/:id/retry',
        'GET /api/v1/events',
        'GET /api/v1/audit',
      ],
    });
  });

  app.use('/api/v1', createSystemRouter(deps));
  app.use('/api/v1/jobs', createJobsRouter(deps));

  app.use((_req, _res, next) => next(new HttpError(404, 'route not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) {
      logger.error('request failed', { error, path: _req.path });
    }
    res.status(status).json({
      error: {
        message: status === 500 ? 'internal server error' : error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  });

  return app;
}

module.exports = { createApp };
