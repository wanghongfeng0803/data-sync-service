const { getDatabase } = require('../db');

function createEventRepository(database = getDatabase()) {
  const insertStmt = database.prepare(
    `INSERT INTO event_log (event, payload, created_at)
     VALUES (@event, @payload, @created_at)`,
  );
  const listStmt = database.prepare(
    `SELECT id, event, payload, created_at
     FROM event_log
     WHERE (@event IS NULL OR event = @event)
     ORDER BY id DESC
     LIMIT @limit OFFSET @offset`,
  );
  const countStmt = database.prepare(
    `SELECT COUNT(*) AS count FROM event_log WHERE (@event IS NULL OR event = @event)`,
  );

  return {
    record(envelope) {
      insertStmt.run({
        event: envelope.event,
        payload: JSON.stringify(envelope.payload || {}),
        created_at: envelope.ts,
      });
    },

    list({ event = null, limit = 50, offset = 0 } = {}) {
      const rows = listStmt.all({ event, limit, offset });
      return rows.map((row) => ({
        ...row,
        payload: JSON.parse(row.payload),
      }));
    },

    count(event = null) {
      return countStmt.get({ event }).count;
    },
  };
}

module.exports = { createEventRepository };
