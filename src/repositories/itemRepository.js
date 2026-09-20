const { getDatabase } = require('../db');

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    payload: JSON.parse(row.payload),
    last_error: row.last_error ?? undefined,
    next_attempt_at: row.next_attempt_at ?? undefined,
    processed_at: row.processed_at ?? undefined,
  };
}

function createItemRepository(database = getDatabase()) {
  const insertManyStmt = database.prepare(
    `INSERT INTO sync_items
       (id, job_id, item_key, payload, status, attempts, created_at)
     VALUES
       (@id, @job_id, @item_key, @payload, 'pending', 0, @created_at)
     ON CONFLICT(id) DO NOTHING`,
  );
  const listByJobStmt = database.prepare(
    `SELECT * FROM sync_items
     WHERE job_id = ?
     ORDER BY created_at ASC
     LIMIT ? OFFSET ?`,
  );
  const countByJobStmt = database.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'succeeded') AS succeeded,
       SUM(status = 'failed') AS failed,
       SUM(status = 'processing') AS processing,
       SUM(status = 'pending') AS pending,
       SUM(status = 'retrying') AS retrying,
       SUM(status = 'dead_lettered') AS dead_lettered
     FROM sync_items WHERE job_id = ?`,
  );
  const claimOneStmt = database.prepare(
    `UPDATE sync_items
     SET status = 'processing', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM sync_items
       WHERE job_id = @job_id
         AND (status = 'pending'
              OR (status = 'retrying' AND (next_attempt_at IS NULL OR next_attempt_at <= @now)))
       ORDER BY next_attempt_at ASC
       LIMIT 1
     )
     RETURNING *`,
  );
  const markSucceededStmt = database.prepare(
    `UPDATE sync_items
     SET status = 'succeeded', last_error = NULL, processed_at = @now
     WHERE id = @id`,
  );
  const markRetryingStmt = database.prepare(
    `UPDATE sync_items
     SET status = 'retrying', last_error = @error, next_attempt_at = @next_attempt_at
     WHERE id = @id`,
  );
  const markDeadLetterStmt = database.prepare(
    `UPDATE sync_items
     SET status = 'dead_lettered', last_error = @error, processed_at = @now
     WHERE id = @id`,
  );
  const dueRetryIdsStmt = database.prepare(
    `SELECT DISTINCT job_id FROM sync_items
     WHERE status = 'retrying' AND next_attempt_at <= ?
     LIMIT ?`,
  );
  const resetInterruptedStmt = database.prepare(
    `UPDATE sync_items
     SET status = 'retrying',
         next_attempt_at = @now,
         last_error = COALESCE(last_error, 'interrupted by process restart')
     WHERE status = 'processing'`,
  );
  const reopenTerminalStmt = database.prepare(
    `UPDATE sync_items
     SET status = 'pending',
         last_error = NULL,
         next_attempt_at = NULL,
         processed_at = NULL,
         attempts = 0
     WHERE job_id = @job_id AND status IN ('failed', 'dead_lettered')`,
  );

  return {
    createMany(items) {
      const now = new Date().toISOString();
      const tx = database.transaction((rows) => {
        for (const item of rows) {
          insertManyStmt.run({
            id: item.id,
            job_id: item.job_id,
            item_key: item.item_key,
            payload: JSON.stringify(item.payload),
            created_at: now,
          });
        }
      });
      tx(items);
    },

    listByJob(jobId, { limit = 100, offset = 0 } = {}) {
      return listByJobStmt.all(jobId, limit, offset).map(hydrate);
    },

    countsByJob(jobId) {
      const row = countByJobStmt.get(jobId);
      return {
        total: row.total ?? 0,
        succeeded: row.succeeded ?? 0,
        failed: row.failed ?? 0,
        processing: row.processing ?? 0,
        pending: row.pending ?? 0,
        retrying: row.retrying ?? 0,
        dead_lettered: row.dead_lettered ?? 0,
      };
    },

    claimNext(jobId) {
      return hydrate(claimOneStmt.get({ job_id: jobId, now: new Date().toISOString() }));
    },

    markSucceeded(id) {
      markSucceededStmt.run({ id, now: new Date().toISOString() });
    },

    markRetrying(id, error, nextAttemptAt) {
      markRetryingStmt.run({ id, error, next_attempt_at: nextAttemptAt });
    },

    markDeadLettered(id, error) {
      markDeadLetterStmt.run({ id, error, now: new Date().toISOString() });
    },

    findDueRetryJobIds(limit = 10) {
      return dueRetryIdsStmt.all(new Date().toISOString(), limit).map((row) => row.job_id);
    },

    resetInterrupted() {
      return resetInterruptedStmt.run({ now: new Date().toISOString() }).changes;
    },

    reopenTerminal(jobId) {
      return reopenTerminalStmt.run({ job_id: jobId }).changes;
    },
  };
}

module.exports = { createItemRepository };
