ALTER TABLE memberships ADD COLUMN cycle_id uuid;
UPDATE memberships SET cycle_id=id;
ALTER TABLE memberships ALTER COLUMN cycle_id SET DEFAULT gen_random_uuid();
ALTER TABLE memberships ALTER COLUMN cycle_id SET NOT NULL;
ALTER TABLE memberships ADD COLUMN pause_review_required boolean NOT NULL DEFAULT false;

CREATE TABLE pause_intervals (
 id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 cycle_id uuid NOT NULL, start_date date NOT NULL, end_date date,
 remark text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(end_date IS NULL OR end_date>=start_date)
);
CREATE UNIQUE INDEX pause_intervals_open ON pause_intervals(member_id) WHERE end_date IS NULL;
CREATE INDEX pause_intervals_cycle ON pause_intervals(member_id,cycle_id);
CREATE TABLE card_appointments (
 id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 action text NOT NULL CHECK(action IN ('pause','resume')), effective_date date NOT NULL,
 remark text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled','failed')),
 parent_id uuid REFERENCES card_appointments(id), error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX card_appointments_pending ON card_appointments(member_id,action) WHERE status='pending';
CREATE TABLE notifications (
 id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 event_key text NOT NULL UNIQUE, kind text NOT NULL, title text NOT NULL,
 effective_date date NOT NULL, read_at timestamptz, obsolete boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reminder_state(id integer PRIMARY KEY CHECK(id=1), checked_date date NOT NULL);
INSERT INTO reminder_state VALUES(1,(now() AT TIME ZONE 'Asia/Shanghai')::date);

-- Completed v1.3 pauses already carry exact effective dates in their immutable events.
INSERT INTO pause_intervals(id,member_id,cycle_id,start_date,end_date,created_at)
SELECT e.id,e.member_id,
 CASE WHEN e.created_at>=COALESCE((SELECT max(r.created_at) FROM membership_events r WHERE r.member_id=e.member_id AND r.event_type='renewed'
 AND ((r.detail->'before'->>'voided_at') IS NOT NULL OR (r.detail->'before'->>'end_date')<substring((r.created_at AT TIME ZONE 'Asia/Shanghai')::text,1,10))),'-infinity'::timestamptz) THEN c.cycle_id ELSE e.id END,
 (e.detail->>'pausedOn')::date,(e.detail->>'resumedOn')::date,e.created_at
FROM membership_events e JOIN memberships c ON c.member_id=e.member_id
WHERE e.event_type='resumed' AND e.detail->>'pausedOn' ~ '^\d{4}-\d{2}-\d{2}$' AND e.detail->>'resumedOn' ~ '^\d{4}-\d{2}-\d{2}$'
 AND pg_input_is_valid(e.detail->>'pausedOn','date') AND pg_input_is_valid(e.detail->>'resumedOn','date')
 AND e.detail->>'resumedOn'>=e.detail->>'pausedOn';
INSERT INTO pause_intervals(id,member_id,cycle_id,start_date,remark)
SELECT gen_random_uuid(),member_id,cycle_id,paused_on,'从旧版暂停状态迁移' FROM memberships WHERE paused_on IS NOT NULL;
INSERT INTO pause_intervals(id,member_id,cycle_id,start_date,end_date,created_at)
SELECT e.id,e.member_id,e.id,(e.detail->'before'->>'paused_on')::date,(e.detail->'refund'->>'asOf')::date,e.created_at
FROM membership_events e WHERE e.event_type='returned' AND e.detail->'before'->>'paused_on' ~ '^\d{4}-\d{2}-\d{2}$'
AND e.detail->'refund'->>'asOf' ~ '^\d{4}-\d{2}-\d{2}$'
AND pg_input_is_valid(e.detail->'before'->>'paused_on','date') AND pg_input_is_valid(e.detail->'refund'->>'asOf','date')
AND e.detail->'refund'->>'asOf'>=e.detail->'before'->>'paused_on';
UPDATE memberships c SET pause_review_required=true WHERE EXISTS(
 SELECT 1 FROM membership_events e WHERE e.member_id=c.member_id AND e.event_type='resumed'
 AND NOT EXISTS(SELECT 1 FROM pause_intervals p WHERE p.id=e.id)
);
UPDATE memberships c SET pause_review_required=true WHERE
 c.pause_count<>(SELECT count(*) FROM pause_intervals p WHERE p.member_id=c.member_id)
 OR EXISTS(SELECT 1 FROM pause_intervals a JOIN pause_intervals b ON a.member_id=b.member_id AND a.cycle_id=b.cycle_id AND a.id<>b.id
 WHERE a.member_id=c.member_id AND a.start_date<COALESCE(b.end_date,'infinity'::date) AND b.start_date<COALESCE(a.end_date,'infinity'::date));
