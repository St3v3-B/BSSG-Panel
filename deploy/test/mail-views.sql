-- Only for deploy/test/mail-stack.sh: imitates the mail schema and views of INTERFACE.md (the real
-- migration lives in packages/db). The test inserts its own rows afterwards.
CREATE SCHEMA mail;

CREATE TABLE mail.domains (
  id serial PRIMARY KEY,
  domain text NOT NULL UNIQUE,
  description text,
  max_mailboxes int NOT NULL DEFAULT 0,
  max_quota_mb int NOT NULL DEFAULT 0,
  dns_status text NOT NULL DEFAULT 'pending',
  dns_checked_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  owner_user_id int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail.mailboxes (
  id serial PRIMARY KEY,
  domain_id int NOT NULL REFERENCES mail.domains(id) ON DELETE CASCADE,
  local_part text NOT NULL,
  address text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  quota_mb int NOT NULL DEFAULT 1024,
  last_login timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id, local_part)
);

CREATE TABLE mail.aliases (
  id serial PRIMARY KEY,
  domain_id int NOT NULL REFERENCES mail.domains(id) ON DELETE CASCADE,
  address text NOT NULL UNIQUE,
  goto text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW mail.v_domains AS
  SELECT domain FROM mail.domains WHERE active;

CREATE VIEW mail.v_mailboxes AS
  SELECT m.address, d.domain, m.local_part, m.password_hash, m.quota_mb,
         d.domain || '/' || m.local_part || '/' AS maildir
  FROM mail.mailboxes m JOIN mail.domains d ON d.id = m.domain_id
  WHERE m.active AND d.active;

CREATE VIEW mail.v_aliases AS
  SELECT a.address, a.goto
  FROM mail.aliases a JOIN mail.domains d ON d.id = a.domain_id
  WHERE a.active AND d.active;

CREATE VIEW mail.v_senders AS
  SELECT address AS sender, address AS login FROM mail.v_mailboxes
  UNION
  SELECT a.address AS sender, mb.address AS login
  FROM mail.v_aliases a
  CROSS JOIN LATERAL unnest(string_to_array(a.goto, ',')) AS g(target)
  JOIN mail.v_mailboxes mb ON mb.address = lower(trim(g.target));

CREATE ROLE mail_reader LOGIN PASSWORD 'replaced-by-the-test';
GRANT USAGE ON SCHEMA mail TO mail_reader;
GRANT SELECT ON mail.v_domains, mail.v_mailboxes, mail.v_aliases, mail.v_senders TO mail_reader;
