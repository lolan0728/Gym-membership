ALTER TABLE membership_events
  ADD COLUMN IF NOT EXISTS remark text NOT NULL DEFAULT '';
