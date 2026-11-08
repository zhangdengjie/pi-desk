CREATE TABLE task_schedules (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name             TEXT NOT NULL DEFAULT '',
  prompt           TEXT NOT NULL DEFAULT '',
  workspace_id     TEXT NOT NULL DEFAULT '',
  model_provider   TEXT,
  model_id         TEXT,
  model_name       TEXT,
  thinking_level   TEXT,
  kind             TEXT NOT NULL,
  time_of_day      TEXT,
  weekday          INTEGER,
  run_at           INTEGER,
  timezone         TEXT NOT NULL DEFAULT 'local',
  enabled          INTEGER NOT NULL DEFAULT 1,
  catch_up         INTEGER NOT NULL DEFAULT 1,
  next_run_at      INTEGER,
  last_run_at      INTEGER,
  last_catch_up_at INTEGER,
  last_status      TEXT NOT NULL DEFAULT '',
  last_error       TEXT NOT NULL DEFAULT '',
  last_thread_id   TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_task_schedules_due ON task_schedules(enabled, next_run_at);
CREATE INDEX idx_task_schedules_task ON task_schedules(task_id);

CREATE TABLE task_worktrees (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL DEFAULT '',
  parent_workspace_id TEXT NOT NULL DEFAULT '',
  path                TEXT NOT NULL,
  branch              TEXT NOT NULL,
  base_ref            TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          INTEGER NOT NULL,
  removed_at          INTEGER,
  UNIQUE(path)
);

CREATE INDEX idx_task_worktrees_task ON task_worktrees(task_id, status);
