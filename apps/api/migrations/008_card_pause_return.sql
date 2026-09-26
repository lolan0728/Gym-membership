-- Additive upgrade: all existing identifiers, dates and history remain unchanged.
ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS paused_on date,
  ADD COLUMN IF NOT EXISTS pause_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_paused_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz;

ALTER TABLE memberships ADD CONSTRAINT memberships_pause_state_check
  CHECK(pause_count >= 0 AND total_paused_days >= 0
    AND (paused_on IS NULL OR (voided_at IS NULL AND pause_count > 0 AND paused_on >= start_date AND paused_on <= end_date))
    AND (returned_at IS NULL OR (voided_at IS NOT NULL AND paused_on IS NULL)));

ALTER TABLE membership_events DROP CONSTRAINT membership_events_event_type_check;
ALTER TABLE membership_events ADD CONSTRAINT membership_events_event_type_check
  CHECK(event_type IN ('opened','renewed','updated','voided','migrated','paused','resumed','returned'));
