const { getDatabase } = require('../db');

function createAuditRepository(database = getDatabase()) {
  const insertStmt = database.prepare(
    `INSERT INTO audit_log (action, job_id, actor, detail, created_at)
     VALUES (@action, @job_id, @actor, @detail, @created_at)`,
  );
  const listStmt = database.prepare(
    `SELECT id, action, job_id, actor, detail, created_at
     FROM audit_log
     WHERE (@action IS NULL OR action = @action)
       AND (@job_id IS NULL OR job_id = @job_id)
     ORDER BY id DESC
     LIMIT @limit OFFSET @offset`,
  );

  return {
    record(action, { jobId = null, actor = 'system', detail = {} } = {}) {
      insertStmt.run({
        action,
        job_id: jobId,
        actor,
        detail: JSON.stringify(detail),
        created_at: new Date().toISOString(),
      });
    },

    list({ action = null, jobId = null, limit = 50, offset = 0 } = {}) {
      const rows = listStmt.all({ action, job_id: jobId, limit, offset });
      return rows.map((row) => ({
        ...row,
        job_id: row.job_id ?? undefined,
        detail: JSON.parse(row.detail),
      }));
    },
  };
}

module.exports = { createAuditRepository };
