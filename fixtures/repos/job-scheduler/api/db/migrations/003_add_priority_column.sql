ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_jobs_status_run_at;
CREATE INDEX IF NOT EXISTS idx_jobs_status_priority_run_at ON jobs (status, priority, run_at);
