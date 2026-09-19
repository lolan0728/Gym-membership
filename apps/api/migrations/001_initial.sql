CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE IF NOT EXISTS administrators (
  id integer PRIMARY KEY CHECK(id=1), password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  id integer PRIMARY KEY CHECK(id=1), name text NOT NULL DEFAULT '你的健身房（待配置）',
  phone text NOT NULL DEFAULT '', logo_key text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS members (
  id uuid PRIMARY KEY, name text NOT NULL, phone varchar(11) NOT NULL UNIQUE CHECK(phone ~ '^1[3-9][0-9]{9}$'),
  card_number varchar(40) NOT NULL UNIQUE, note text NOT NULL DEFAULT '',
  theme text NOT NULL DEFAULT 'gold' CHECK(theme IN ('gold','blue','orange','white')),
  avatar_key text, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES members(id),
  kind text NOT NULL CHECK(kind IN ('year','month')), start_date date NOT NULL, end_date date NOT NULL,
  voided_at timestamptz, void_reason text, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_dates CHECK(start_date <= end_date),
  CONSTRAINT no_overlapping_cards EXCLUDE USING gist
    (member_id WITH =, daterange(start_date,end_date,'[]') WITH &&) WHERE (voided_at IS NULL)
);
CREATE INDEX IF NOT EXISTS memberships_member_idx ON memberships(member_id);
CREATE TABLE IF NOT EXISTS wechat_bindings (
  openid text PRIMARY KEY, member_id uuid NOT NULL UNIQUE REFERENCES members(id), bound_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, role text NOT NULL CHECK(role IN ('admin','wechat')),
  openid text, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((role='admin' AND openid IS NULL) OR (role='wechat' AND openid IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sessions_openid_idx ON sessions(openid);
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY, member_id uuid REFERENCES members(id), action text NOT NULL,
  actor text NOT NULL DEFAULT 'owner', detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_member_idx ON audit_logs(member_id,created_at DESC);
CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY, file_hash text NOT NULL UNIQUE, rows jsonb NOT NULL, errors jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('invalid','ready','committed')),
  created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY, hits integer NOT NULL DEFAULT 1, reset_at timestamptz NOT NULL
);
