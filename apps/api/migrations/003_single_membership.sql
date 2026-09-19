CREATE TABLE IF NOT EXISTS membership_events (
  id uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES members(id),
  membership_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('opened','renewed','updated','voided','migrated')),
  selected_kind text CHECK(selected_kind IN ('year','month')),
  kind text NOT NULL CHECK(kind IN ('year','month')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  voided_at timestamptz,
  void_reason text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_event_valid_dates CHECK(start_date <= end_date)
);

CREATE INDEX IF NOT EXISTS membership_events_member_idx
  ON membership_events(member_id, created_at DESC);

INSERT INTO membership_events(
  id,member_id,membership_id,event_type,selected_kind,kind,start_date,end_date,
  voided_at,void_reason,detail,created_at
)
SELECT id,member_id,id,
  CASE WHEN voided_at IS NULL THEN 'migrated' ELSE 'voided' END,
  kind,kind,start_date,end_date,voided_at,void_reason,'{}'::jsonb,created_at
FROM memberships
ON CONFLICT(id) DO NOTHING;

WITH ranked AS (
  SELECT id,ROW_NUMBER() OVER (
    PARTITION BY member_id
    ORDER BY
      CASE
        WHEN voided_at IS NULL AND start_date<=CURRENT_DATE AND end_date>=CURRENT_DATE THEN 1
        WHEN voided_at IS NULL AND start_date>CURRENT_DATE THEN 2
        WHEN voided_at IS NULL AND end_date<CURRENT_DATE THEN 3
        ELSE 4
      END,
      CASE WHEN voided_at IS NULL AND start_date>CURRENT_DATE THEN start_date END ASC,
      end_date DESC,updated_at DESC,id
  ) AS position
  FROM memberships
)
DELETE FROM memberships WHERE id IN (SELECT id FROM ranked WHERE position>1);

CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_per_member_idx ON memberships(member_id);
