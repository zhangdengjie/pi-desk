CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL,
  workspace_id      TEXT NOT NULL DEFAULT '',
  agent_profile_id  TEXT,
  origin            TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  legacy_thread_id  TEXT UNIQUE,
  metadata          TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER
);

CREATE TABLE task_runs (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  runtime        TEXT NOT NULL,
  session_path   TEXT,
  model_provider TEXT,
  model_id       TEXT,
  status         TEXT NOT NULL,
  attempt        INTEGER NOT NULL DEFAULT 1,
  generation     INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
);

CREATE TABLE run_events (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  type           TEXT NOT NULL,
  payload        TEXT NOT NULL DEFAULT '{}',
  payload_sha256 TEXT,
  payload_bytes  INTEGER NOT NULL DEFAULT 0,
  redacted       INTEGER NOT NULL DEFAULT 0,
  truncated      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE usage_records (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL UNIQUE REFERENCES task_runs(id) ON DELETE CASCADE,
  provider           TEXT,
  model              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost     REAL NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_tasks_status_updated ON tasks(status, updated_at);
CREATE INDEX idx_task_runs_task_created ON task_runs(task_id, created_at);
CREATE INDEX idx_run_events_run_seq ON run_events(run_id, seq);
CREATE INDEX idx_usage_run ON usage_records(run_id);
