ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS month_card_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS year_card_days integer NOT NULL DEFAULT 365;

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_month_card_days_check;
ALTER TABLE settings ADD CONSTRAINT settings_month_card_days_check CHECK(month_card_days BETWEEN 1 AND 3650);
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_year_card_days_check;
ALTER TABLE settings ADD CONSTRAINT settings_year_card_days_check CHECK(year_card_days BETWEEN 1 AND 3650);

ALTER TABLE membership_events
  ADD COLUMN IF NOT EXISTS duration_days integer;

UPDATE membership_events
SET duration_days=(end_date-start_date)
WHERE duration_days IS NULL AND event_type IN ('opened','migrated');

CREATE TABLE IF NOT EXISTS desktop_state (
  id integer PRIMARY KEY CHECK(id=1),
  data_revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO desktop_state(id) VALUES(1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS backup_settings (
  id integer PRIMARY KEY CHECK(id=1),
  directory text NOT NULL DEFAULT '',
  sender_email text NOT NULL DEFAULT '',
  recipient_email text NOT NULL DEFAULT '',
  schedule_time varchar(5) NOT NULL DEFAULT '20:00',
  retention_count integer NOT NULL DEFAULT 30 CHECK(retention_count BETWEEN 1 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO backup_settings(id) VALUES(1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS backup_jobs (
  id uuid PRIMARY KEY,
  file_path text NOT NULL,
  file_name text NOT NULL,
  data_revision bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('local_saved','sent','email_failed')),
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS backup_jobs_created_idx ON backup_jobs(created_at DESC);
