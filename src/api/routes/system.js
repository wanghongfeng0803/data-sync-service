const express = require('express');

function createSystemRouter({ eventRepository, auditRepository, engine, transformPool }) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      time: new Date().toISOString(),
      engine: {
        activeJobs: engine.activeJobs.size,
        inflight: engine.inflight,
      },
      transform: { workers: transformPool.workers.length, queued: transformPool.queue.length },
    });
  });

  router.get('/events', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 50;
    const offset = Number.parseInt(req.query.offset, 10) || 0;
    const event = typeof req.query.event === 'string' ? req.query.event : null;
    res.json({
      items: eventRepository.list({ event, limit, offset }),
      total: eventRepository.count(event),
      limit,
      offset,
    });
  });

  router.get('/audit', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 50;
    const offset = Number.parseInt(req.query.offset, 10) || 0;
    const action = typeof req.query.action === 'string' ? req.query.action : null;
    const jobId = typeof req.query.job_id === 'string' ? req.query.job_id : null;
    res.json({
      items: auditRepository.list({ action, jobId, limit, offset }),
      limit,
      offset,
    });
  });

  return router;
}

module.exports = { createSystemRouter };
