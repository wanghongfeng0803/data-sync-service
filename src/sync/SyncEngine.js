const { randomUUID } = require('node:crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { sleep } = require('../utils/async');
const { getSource, getTarget } = require('../connectors/registry');
const { EVENTS } = require('../eventbus/events');

function fullJitterDelay(attempt, baseMs, factor, maxMs) {
  const expo = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * expo);
}

function pickCounts(job) {
  return {
    total: job.total,
    succeeded: job.succeeded,
    failed: job.failed,
    dead_lettered: job.dead_lettered,
  };
}

class SyncEngine {
  constructor({ eventBus, jobRepository, itemRepository, transformPool, options = {} }) {
    this.bus = eventBus;
    this.jobs = jobRepository;
    this.items = itemRepository;
    this.transformPool = transformPool;
    this.concurrency = options.concurrency ?? config.sync.concurrency;
    this.scanIntervalMs = options.scanIntervalMs ?? config.sync.scanIntervalMs;
    this.backoff = {
      baseMs: options.backoffBaseMs ?? config.sync.backoffBaseMs,
      factor: options.backoffFactor ?? config.sync.backoffFactor,
      maxMs: options.backoffMaxMs ?? config.sync.backoffMaxMs,
    };
    this.activeJobs = new Set();
    this.inflight = 0;
    this.idleWaiters = [];
    this.stopping = false;
    this.timer = null;
  }

  start() {
    const interruptedItems = this.items.resetInterrupted();
    const interruptedJobs = this.jobs.resetInterrupted();
    if (interruptedJobs > 0 || interruptedItems > 0) {
      logger.warn('recovered interrupted work after restart', {
        jobs: interruptedJobs,
        items: interruptedItems,
      });
    }

    this.bus.on(EVENTS.JOB_CREATED, () => this._schedulePoll());
    this.bus.on(EVENTS.JOB_RETRY_REQUESTED, () => this._schedulePoll());

    this.timer = setInterval(() => this._poll(), this.scanIntervalMs);
    this.timer.unref();
    this._schedulePoll();
    logger.info('sync engine started', {
      concurrency: this.concurrency,
      scanIntervalMs: this.scanIntervalMs,
    });
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async waitUntilIdle(timeoutMs = 10000) {
    if (this.inflight === 0 && this.activeJobs.size === 0) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== settle);
        reject(new Error('waitUntilIdle timed out'));
      }, timeoutMs);
      const settle = () => {
        clearTimeout(timer);
        resolve();
      };
      this.idleWaiters.push(settle);
    });
  }

  isJobActive(jobId) {
    return this.activeJobs.has(jobId);
  }

  enqueueRun() {
    this._schedulePoll();
  }

  _schedulePoll() {
    if (this.stopping) return;
    setImmediate(() => {
      this._poll().catch((error) => logger.error('engine poll failed', error));
    });
  }

  async _poll() {
    if (this.stopping) return;

    const pendingJobs = this.jobs.claimPending(10);
    const dueJobIds = this.items.findDueRetryJobIds(10);

    const candidates = new Map();
    for (const job of pendingJobs) candidates.set(job.id, job);
    for (const jobId of dueJobIds) {
      if (!candidates.has(jobId)) {
        const job = this.jobs.get(jobId);
        if (job && job.status === 'running' && !this.activeJobs.has(jobId)) {
          candidates.set(jobId, job);
        }
      }
    }

    for (const job of candidates.values()) {
      if (this.activeJobs.size >= this.concurrency) break;
      if (this.activeJobs.has(job.id)) continue;
      if (job.status === 'pending' && !this.jobs.markRunning(job.id)) continue;
      this._runJob(job.id).catch((error) => {
        logger.error('job run crashed', { jobId: job.id, error });
      });
    }
  }

  async _runJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'cancelled' || this.activeJobs.has(jobId)) return;

    this.activeJobs.add(jobId);
    try {
      if (job.status === 'running' && job.total === 0) {
        const staged = await this._fetchAndStage(job);
        if (!staged) return;
      }
      const current = this.jobs.get(jobId);
      if (!current || current.status === 'cancelled' || current.total === 0) return;

      await this._processItems(current);
      this._settleJob(jobId);
    } finally {
      this.activeJobs.delete(jobId);
      this._notifyIdle();
    }
  }

  async _fetchAndStage(job) {
    this.bus.publish(EVENTS.JOB_STARTED, { jobId: job.id });
    const source = getSource(job.source_type);

    let records;
    try {
      records = await source.fetch(job.source_config);
    } catch (error) {
      logger.error('source fetch failed', { jobId: job.id, error });
      this.jobs.finish(job.id, 'failed', `source fetch failed: ${error.message}`);
      this.bus.publish(EVENTS.JOB_FAILED, { jobId: job.id, error: error.message });
      return false;
    }

    if (!Array.isArray(records)) {
      const error = new Error('source.fetch() must return an array of { key, data }');
      this.jobs.finish(job.id, 'failed', error.message);
      this.bus.publish(EVENTS.JOB_FAILED, { jobId: job.id, error: error.message });
      return false;
    }

    const rows = records.map((record) => ({
      id: randomUUID(),
      job_id: job.id,
      item_key: String(record.key ?? record.data?.id ?? randomUUID()),
      payload: { key: record.key, data: record.data ?? record },
    }));
    this.items.createMany(rows);
    logger.info('job staged', { jobId: job.id, items: rows.length });
    return true;
  }

  async _processItems(job) {
    const share = Math.max(1, Math.floor(this.concurrency / Math.max(1, this.activeJobs.size)));
    const workers = Array.from({ length: share }, () => this._itemWorker(job));
    await Promise.all(workers);
  }

  async _itemWorker(job) {
    while (!this.stopping) {
      const current = this.jobs.get(job.id);
      if (!current || current.status === 'cancelled') return;
      if (this.inflight >= this.concurrency) {
        await sleep(50);
        continue;
      }

      const item = this.items.claimNext(job.id);
      if (!item) return;

      this.inflight += 1;
      try {
        await this._processItem(job, item);
      } catch (error) {
        logger.error('item processing crashed', { jobId: job.id, itemId: item.id, error });
      } finally {
        this.inflight -= 1;
        this._notifyIdle();
      }
    }
  }

  async _processItem(job, item) {
    const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload;
    this.bus.publish(EVENTS.ITEM_PROCESSING, {
      jobId: job.id,
      itemId: item.id,
      key: payload.key,
      attempt: item.attempts,
    });

    try {
      const transformed = await this.transformPool.transform(payload.data, job.mapping);
      const target = getTarget(job.target_type);
      await target.push(
        { key: payload.key, data: transformed },
        job.target_config,
        { attempts: item.attempts, jobId: job.id },
      );

      this.items.markSucceeded(item.id);
      this.bus.publish(EVENTS.ITEM_SUCCEEDED, {
        jobId: job.id,
        itemId: item.id,
        key: payload.key,
        attempt: item.attempts,
      });
    } catch (error) {
      const retryable = error.retryable !== false;
      if (retryable && item.attempts < job.max_attempts) {
        const delayMs = fullJitterDelay(
          item.attempts,
          this.backoff.baseMs,
          this.backoff.factor,
          this.backoff.maxMs,
        );
        const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
        this.items.markRetrying(item.id, error.message, nextAttemptAt);
        this.bus.publish(EVENTS.ITEM_FAILED, {
          jobId: job.id,
          itemId: item.id,
          key: payload.key,
          attempt: item.attempts,
          error: error.message,
        });
        this.bus.publish(EVENTS.ITEM_RETRY_SCHEDULED, {
          jobId: job.id,
          itemId: item.id,
          key: payload.key,
          attempt: item.attempts,
          nextAttemptAt,
          delayMs,
        });
        setTimeout(() => this._schedulePoll(), delayMs).unref();
      } else {
        this.items.markDeadLettered(item.id, error.message);
        this.bus.publish(EVENTS.ITEM_DEAD_LETTERED, {
          jobId: job.id,
          itemId: item.id,
          key: payload.key,
          attempts: item.attempts,
          error: error.message,
          retryable,
        });
      }
    }
  }

  _settleJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return;

    const counts = this.items.countsByJob(jobId);
    const unfinished = counts.pending + counts.processing + counts.retrying;
    if (unfinished > 0) return;

    if (counts.failed > 0 || counts.dead_lettered > 0) {
      const error =
        counts.dead_lettered > 0
          ? `${counts.dead_lettered} item(s) dead-lettered after ${job.max_attempts} attempts`
          : `${counts.failed} item(s) failed`;
      const finished = this.jobs.finish(jobId, 'failed', error);
      this.bus.publish(EVENTS.JOB_FAILED, { jobId, error, counts: pickCounts(finished) });
    } else {
      const finished = this.jobs.finish(jobId, 'completed', null);
      this.bus.publish(EVENTS.JOB_COMPLETED, { jobId, counts: pickCounts(finished) });
    }
  }

  _notifyIdle() {
    if (this.inflight === 0 && this.activeJobs.size === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }
  }
}

module.exports = { SyncEngine, fullJitterDelay };
