const { getDatabase } = require('../db');

const COUNTS_SELECT = `
  (SELECT COUNT(*) FROM sync_items i WHERE i.job_id = j.id) AS total,
  (SELECT COUNT(*) FROM sync_items i WHERE i.job_id = j.id AND i.status = 'succeeded') AS succeeded,
  (SELECT COUNT(*) FROM sync_items i WHERE i.job_id = j.id AND i.status = 'failed') AS failed,
  (SELECT COUNT(*) FROM sync_items i WHERE i.job_id = j.id AND i.status = 'processing') AS processing,
  (SELECT COUNT(*) FROM sync_items i WHERE i.job_id = j.id AND i.status = 'pending') AS pending,
  (SELECT COUNT(*) FROM sync_items i WHERE i.job_id = j.id AND i.status = 'retrying') AS retrying,
  (SELECT COUNT(*) FROM sync_items i WHERE i.job_id = j.id AND i.status = 'dead_lettered') AS dead_lettered
`;

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    source_config: JSON.parse(row.source_config),
    target_config: JSON.parse(row.target_config),
    mapping: JSON.parse(row.mapping),
    error: row.error ?? undefined,
    started_at: row.started_at ?? undefined,
    finished_at: row.finished_at ?? undefined,
  };
}

function createJobRepository(database = getDatabase()) {
  const insertStmt = database.prepare(
    `INSERT INTO sync_jobs
       (id, source_type, source_config, target_type, target_config, mapping,
        status, max_attempts, created_at)
     VALUES
       (@id, @source_type, @source_config, @target_type, @target_config, @mapping,
        @status, @max_attempts, @created_at)`,
  );
  const getStmt = database.prepare(`SELECT *, ${COUNTS_SELECT} FROM sync_jobs j WHERE id = ?`);
  const listStmt = database.prepare(
    `SELECT j.*, ${COUNTS_SELECT}
     FROM sync_jobs j
     WHERE (@status IS NULL OR j.status = @status)
     ORDER BY j.created_at DESC
     LIMIT @limit OFFSET @offset`,
  );
  const countStmt = database.prepare(
    `SELECT COUNT(*) AS count FROM sync_jobs WHERE (@status IS NULL OR status = @status)`,
  );
  const claimPendingStmt = database.prepare(
    `SELECT * FROM sync_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
  );
  const markRunningStmt = database.prepare(
    `UPDATE sync_jobs
     SET status = 'running', started_at = COALESCE(started_at, @now)
     WHERE id = @id AND status IN ('pending', 'failed')`,
  );
  const finishStmt = database.prepare(
    `UPDATE sync_jobs
     SET status = @status, error = @error, finished_at = @now
     WHERE id = @id AND status NOT IN ('cancelled')`,
  );
  const cancelStmt = database.prepare(
    `UPDATE sync_jobs SET status = 'cancelled', finished_at = @now
     WHERE id = @id AND status IN ('pending', 'running', 'failed')`,
  );
  const reopenStmt = database.prepare(
    `UPDATE sync_jobs
     SET status = 'pending',
         error = NULL,
         finished_at = NULL,
         max_attempts = @max_attempts
     WHERE id = @id AND status IN ('failed', 'completed')`,
  );
  const resetInterruptedStmt = database.prepare(
    `UPDATE sync_jobs SET status = 'pending', started_at = NULL
     WHERE status = 'running'`,
  );

  return {
    create(job) {
      insertStmt.run({
        id: job.id,
        source_type: job.source_type,
        source_config: JSON.stringify(job.source_config || {}),
        target_type: job.target_type,
        target_config: JSON.stringify(job.target_config || {}),
        mapping: JSON.stringify(job.mapping || {}),
        status: job.status,
        max_attempts: job.max_attempts,
        created_at: job.created_at,
      });
      return this.get(job.id);
    },

    get(id) {
      return hydrate(getStmt.get(id));
    },

    list({ status = null, limit = 20, offset = 0 } = {}) {
      return listStmt.all({ status, limit, offset }).map(hydrate);
    },

    count(status = null) {
      return countStmt.get({ status }).count;
    },

    claimPending(limit = 1) {
      return claimPendingStmt.all(limit).map(hydrate);
    },

    markRunning(id) {
      return markRunningStmt.run({ id, now: new Date().toISOString() }).changes > 0;
    },

    finish(id, status, error = null) {
      finishStmt.run({ id, status, error, now: new Date().toISOString() });
      return this.get(id);
    },

    cancel(id) {
      return cancelStmt.run({ id, now: new Date().toISOString() }).changes > 0;
    },

    reopen(id, maxAttempts) {
      return reopenStmt.run({ id, max_attempts: maxAttempts, now: new Date().toISOString() }).changes > 0;
    },

    resetInterrupted() {
      return resetInterruptedStmt.run().changes;
    },
  };
}

module.exports = { createJobRepository };
