const { randomUUID } = require('node:crypto');
const express = require('express');
const config = require('../../config');
const { getSource, getTarget } = require('../../connectors/registry');
const { EVENTS } = require('../../eventbus/events');
const { badRequest, notFound } = require('../errors');

function createJobsRouter({ eventBus, jobRepository, itemRepository, auditRepository, engine }) {
  const router = express.Router();

  router.post('/', (req, res, next) => {
    try {
      const body = req.body ?? {};
      const sourceType = body.source?.type;
      const targetType = body.target?.type;
      if (!sourceType || !targetType) {
        throw badRequest('source.type and target.type are required');
      }
      getSource(sourceType);
      getTarget(targetType);

      const maxAttempts = body.max_attempts ?? config.sync.defaultMaxAttempts;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        throw badRequest('max_attempts must be an integer between 1 and 20');
      }

      const now = new Date().toISOString();
      const job = jobRepository.create({
        id: randomUUID(),
        source_type: sourceType,
        source_config: body.source.config || {},
        target_type: targetType,
        target_config: body.target.config || {},
        mapping: body.mapping || {},
        status: 'pending',
        max_attempts: maxAttempts,
        created_at: now,
      });

      auditRepository.record('job.created', { jobId: job.id, actor: 'api', detail: { sourceType, targetType } });
      eventBus.publish(EVENTS.JOB_CREATED, {
        jobId: job.id,
        sourceType,
        targetType,
        maxAttempts,
      });

      res.status(202).json({ job });
    } catch (error) {
      next(error);
    }
  });

  router.get('/', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 20;
    const offset = Number.parseInt(req.query.offset, 10) || 0;
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    res.json({
      items: jobRepository.list({ status, limit, offset }),
      total: jobRepository.count(status),
      limit,
      offset,
    });
  });

  router.get('/:id', (req, res, next) => {
    const job = jobRepository.get(req.params.id);
    if (!job) return next(notFound(`job ${req.params.id} not found`));
    res.json({ job });
  });

  router.get('/:id/items', (req, res, next) => {
    const job = jobRepository.get(req.params.id);
    if (!job) return next(notFound(`job ${req.params.id} not found`));
    const limit = Number.parseInt(req.query.limit, 10) || 100;
    const offset = Number.parseInt(req.query.offset, 10) || 0;
    res.json({
      items: itemRepository.listByJob(job.id, { limit, offset }),
      counts: itemRepository.countsByJob(job.id),
      limit,
      offset,
    });
  });

  router.post('/:id/cancel', (req, res, next) => {
    try {
      const job = jobRepository.get(req.params.id);
      if (!job) throw notFound(`job ${req.params.id} not found`);
      if (!['pending', 'running', 'failed'].includes(job.status)) {
        throw badRequest(`cannot cancel job in status "${job.status}"`);
      }
      const cancelled = jobRepository.cancel(job.id);
      if (!cancelled) throw badRequest('cancel did not apply');
      auditRepository.record('job.cancelled', { jobId: job.id, actor: 'api' });
      eventBus.publish(EVENTS.JOB_CANCELLED, { jobId: job.id });
      res.json({ job: jobRepository.get(job.id) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/retry', (req, res, next) => {
    try {
      const job = jobRepository.get(req.params.id);
      if (!job) throw notFound(`job ${req.params.id} not found`);
      if (!['failed', 'completed'].includes(job.status)) {
        throw badRequest(`only failed/completed jobs can be retried, current status "${job.status}"`);
      }
      if (engine.isJobActive(job.id)) {
        throw badRequest('job is currently active');
      }

      const maxAttempts = req.body?.max_attempts ?? job.max_attempts;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        throw badRequest('max_attempts must be an integer between 1 and 20');
      }

      const reopened = jobRepository.reopen(job.id, maxAttempts);
      if (!reopened) throw badRequest('retry did not apply');
      itemRepository.reopenTerminal(job.id);

      auditRepository.record('job.retried', {
        jobId: job.id,
        actor: 'api',
        detail: { maxAttempts },
      });
      eventBus.publish(EVENTS.JOB_RETRY_REQUESTED, { jobId: job.id, maxAttempts });
      res.status(202).json({ job: jobRepository.get(job.id) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createJobsRouter };
