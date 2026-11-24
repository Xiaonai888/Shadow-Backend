BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name = 'id' AND udt_name = 'uuid'
    ) THEN
        RAISE EXCEPTION 'Expected public.users.id to be uuid. Review preflight before installing.';
    END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS shadow_account_lifecycle;
REVOKE ALL ON SCHEMA shadow_account_lifecycle FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS shadow_account_lifecycle.settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    backend_ready boolean NOT NULL DEFAULT false
);

INSERT INTO shadow_account_lifecycle.settings (singleton, backend_ready)
VALUES (true, false) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS shadow_account_lifecycle.deletion_records (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id uuid NOT NULL,
    requested_by text NOT NULL CHECK (requested_by IN ('reader', 'admin')),
    deleted_by text NOT NULL,
    deleted_at timestamptz NOT NULL,
    recover_until timestamptz NOT NULL,
    restored_at timestamptz,
    restored_by text,
    CONSTRAINT valid_recovery_period CHECK (
        recover_until = ((deleted_at AT TIME ZONE 'UTC') + interval '5 years') AT TIME ZONE 'UTC'
    ),
    CONSTRAINT valid_restoration CHECK (
        (restored_at IS NULL AND restored_by IS NULL) OR
        (restored_at IS NOT NULL AND restored_by IS NOT NULL AND restored_at >= deleted_at AND restored_at < recover_until)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS shadow_account_one_open_deletion
ON shadow_account_lifecycle.deletion_records (user_id)
WHERE restored_at IS NULL;

CREATE INDEX IF NOT EXISTS shadow_account_recovery_deadline
ON shadow_account_lifecycle.deletion_records (recover_until)
WHERE restored_at IS NULL;

ALTER TABLE shadow_account_lifecycle.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE shadow_account_lifecycle.deletion_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA shadow_account_lifecycle FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA shadow_account_lifecycle FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
