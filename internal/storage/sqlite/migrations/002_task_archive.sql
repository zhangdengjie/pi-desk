ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
CREATE INDEX idx_tasks_archived_updated ON tasks(archived_at, updated_at DESC);
