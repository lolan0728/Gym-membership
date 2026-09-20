ALTER TABLE backup_jobs
  ADD COLUMN IF NOT EXISTS trigger_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS scheduled_date date;

ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_trigger_source_check;
ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_trigger_source_check
  CHECK(trigger_source IN ('manual','automatic','pre_restore'));

CREATE UNIQUE INDEX IF NOT EXISTS backup_jobs_automatic_date_unique
  ON backup_jobs(scheduled_date)
  WHERE trigger_source='automatic';

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS flushed_at timestamptz;

CREATE INDEX IF NOT EXISTS audit_logs_unflushed_idx
  ON audit_logs(created_at,id)
  WHERE flushed_at IS NULL;

CREATE TABLE IF NOT EXISTS member_number_sequences (
  month_key char(6) PRIMARY KEY,
  last_value integer NOT NULL CHECK(last_value BETWEEN 1 AND 9999)
);

-- Move every existing member to the new stable monthly sequence. The temporary
-- value avoids collisions with the unique card_number constraint while rows
-- are being rewritten.
UPDATE members SET card_number='MIG-' || id;

WITH ranked AS (
  SELECT id,
         to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYYMM') AS month_key,
         row_number() OVER (
           PARTITION BY to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYYMM')
           ORDER BY created_at,id
         ) AS sequence_value
  FROM members
)
UPDATE members m
SET card_number='Y' || ranked.month_key || lpad(ranked.sequence_value::text,4,'0')
FROM ranked
WHERE ranked.id=m.id;

INSERT INTO member_number_sequences(month_key,last_value)
SELECT substring(card_number from 2 for 6),max(substring(card_number from 8 for 4)::integer)
FROM members
WHERE card_number ~ '^Y[0-9]{10}$'
GROUP BY substring(card_number from 2 for 6)
ON CONFLICT(month_key) DO UPDATE SET last_value=GREATEST(member_number_sequences.last_value,EXCLUDED.last_value);
