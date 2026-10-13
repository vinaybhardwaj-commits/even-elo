-- Studio state (M0-S2). Applied by apply_migration.py, which FIRST calls the langgraph checkpointer
-- setup() (checkpoint_migrations, checkpoints, checkpoint_blobs, checkpoint_writes) and THEN runs this
-- file in one transaction. Idempotent. {{app_role}} is replaced by the runner (validated identifier,
-- must already exist); this file never creates roles.

CREATE TABLE IF NOT EXISTS studio_migrations (
  id         text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- One row per governance tool call. Metadata only: NEVER row content.
CREATE TABLE IF NOT EXISTS studio_audit (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  staff_id    text        NOT NULL,
  tool        text        NOT NULL,
  params_hash text        NOT NULL,
  row_count   integer     NOT NULL CHECK (row_count >= 0),
  duration_ms integer     NOT NULL CHECK (duration_ms >= 0),
  mode        text        NOT NULL CHECK (mode IN ('live', 'fixture'))
);
CREATE INDEX IF NOT EXISTS idx_studio_audit_staff_ts ON studio_audit (staff_id, ts DESC);

-- Append-only: the trigger blocks UPDATE/DELETE/TRUNCATE for every role, the REVOKE below
-- removes the privileges from the app role (defence in depth).
CREATE OR REPLACE FUNCTION studio_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'studio_audit is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS studio_audit_no_update_delete ON studio_audit;
CREATE TRIGGER studio_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON studio_audit
  FOR EACH ROW EXECUTE FUNCTION studio_audit_append_only();
DROP TRIGGER IF EXISTS studio_audit_no_truncate ON studio_audit;
CREATE TRIGGER studio_audit_no_truncate
  BEFORE TRUNCATE ON studio_audit
  FOR EACH STATEMENT EXECUTE FUNCTION studio_audit_append_only();

-- Actor-token replay protection. Ops prunes rows older than a day (tokens live <= 60 s).
CREATE TABLE IF NOT EXISTS studio_nonce (
  jti        text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_studio_nonce_created ON studio_nonce (created_at);

-- Thread ownership / archive flag (threads are namespaced "<staff id>:<thread id>").
CREATE TABLE IF NOT EXISTS studio_threads (
  thread_id  text PRIMARY KEY,
  staff_id   text        NOT NULL,
  archived   boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_studio_threads_staff ON studio_threads (staff_id, archived);

-- Grants. The app role can append to the audit and read it, never change or remove rows.
REVOKE ALL ON studio_audit, studio_nonce, studio_threads, studio_migrations FROM PUBLIC;
REVOKE ALL ON studio_audit FROM {{app_role}};
GRANT SELECT, INSERT ON studio_audit TO {{app_role}};
GRANT USAGE ON SEQUENCE studio_audit_id_seq TO {{app_role}};
GRANT SELECT, INSERT, DELETE ON studio_nonce TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON studio_threads TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON checkpoint_migrations, checkpoints, checkpoint_blobs, checkpoint_writes TO {{app_role}};

INSERT INTO studio_migrations (id) VALUES ('0001_studio') ON CONFLICT (id) DO NOTHING;
