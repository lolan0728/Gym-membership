ALTER TABLE desktop_state
  ADD COLUMN IF NOT EXISTS pending_backup_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_backup_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_emailed_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_backup_error text NOT NULL DEFAULT '';

ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_status_check;
ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_status_check
  CHECK(status IN ('local_saved','sent','email_failed','superseded'));

ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_trigger_source_check;
ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_trigger_source_check
  CHECK(trigger_source IN ('manual','automatic','pre_restore','change'));

CREATE INDEX IF NOT EXISTS backup_jobs_change_revision_idx
  ON backup_jobs(data_revision,created_at DESC)
  WHERE trigger_source='change';
