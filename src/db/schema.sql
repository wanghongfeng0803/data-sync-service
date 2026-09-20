PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_config TEXT NOT NULL DEFAULT '{}',
  target_type TEXT NOT NULL,
  target_config TEXT NOT NULL DEFAULT '{}',
  mapping TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  max_attempts INTEGER NOT NULL DEFAULT 5,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_created_at ON sync_jobs(created_at);

CREATE TABLE IF NOT EXISTS sync_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  next_attempt_at TEXT,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_items_job ON sync_items(job_id);
CREATE INDEX IF NOT EXISTS idx_sync_items_retry
  ON sync_items(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_log_event ON event_log(event, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  job_id TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_job ON audit_log(job_id, id);
