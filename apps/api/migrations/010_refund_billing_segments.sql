-- Immutable billing snapshots for purchase events. These columns only explain
-- refunds; they never alter an existing membership's dates or status.
ALTER TABLE membership_events ADD COLUMN cycle_id uuid;
ALTER TABLE membership_events ADD COLUMN refund_basis_days integer CHECK(refund_basis_days IS NULL OR refund_basis_days>0);
ALTER TABLE membership_events ADD COLUMN refund_price integer CHECK(refund_price IS NULL OR refund_price>=0);
ALTER TABLE membership_events ADD COLUMN granted_days integer CHECK(granted_days IS NULL OR granted_days>=0);
ALTER TABLE membership_events ADD COLUMN gift_days integer CHECK(gift_days IS NULL OR gift_days>=0);

UPDATE membership_events
SET refund_basis_days=CASE WHEN COALESCE(selected_kind,kind)='year' THEN 365 ELSE 30 END,
    refund_price=CASE WHEN COALESCE(selected_kind,kind)='year' THEN 499 ELSE 99 END,
    granted_days=GREATEST(0,
      CASE WHEN event_type='renewed' AND detail->'before'->>'end_date' ~ '^\d{4}-\d{2}-\d{2}$'
        AND detail->'before'->>'voided_at' IS NULL
        AND (detail->'before'->>'end_date')::date>=(created_at AT TIME ZONE 'Asia/Shanghai')::date
        THEN end_date-(detail->'before'->>'end_date')::date ELSE end_date-start_date END),
    gift_days=GREATEST(0,
      (CASE WHEN event_type='renewed' AND detail->'before'->>'end_date' ~ '^\d{4}-\d{2}-\d{2}$'
        AND detail->'before'->>'voided_at' IS NULL
        AND (detail->'before'->>'end_date')::date>=(created_at AT TIME ZONE 'Asia/Shanghai')::date
        THEN end_date-(detail->'before'->>'end_date')::date ELSE end_date-start_date END)
      -(CASE WHEN COALESCE(selected_kind,kind)='year' THEN 365 ELSE 30 END))
WHERE event_type IN ('opened','renewed','migrated');

CREATE INDEX membership_events_refund_cycle ON membership_events(member_id,cycle_id,created_at);
