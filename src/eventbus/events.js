const EVENTS = Object.freeze({
  JOB_CREATED: 'job.created',
  JOB_STARTED: 'job.started',
  JOB_FAILED: 'job.failed',
  JOB_COMPLETED: 'job.completed',
  JOB_CANCELLED: 'job.cancelled',
  JOB_RETRY_REQUESTED: 'job.retry.requested',
  ITEM_PROCESSING: 'item.processing',
  ITEM_SUCCEEDED: 'item.succeeded',
  ITEM_FAILED: 'item.failed',
  ITEM_RETRY_SCHEDULED: 'item.retry.scheduled',
  ITEM_DEAD_LETTERED: 'item.dead_lettered',
});

module.exports = { EVENTS };
