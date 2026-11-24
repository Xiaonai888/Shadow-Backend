BEGIN;

CREATE OR REPLACE FUNCTION shadow_account_lifecycle.soft_delete_account(
    p_user_id uuid,
    p_requested_by text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, shadow_account_lifecycle
AS $$
DECLARE
    v_id bigint;
    v_now timestamptz;
BEGIN
    IF p_user_id IS NULL OR p_requested_by IS NULL OR p_requested_by NOT IN ('reader', 'admin') THEN
        RAISE EXCEPTION 'Invalid deletion request';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM shadow_account_lifecycle.settings WHERE singleton AND backend_ready) THEN
        RAISE EXCEPTION 'Account lifecycle is not enabled. Deploy and verify backend guards first.';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
    PERFORM 1 FROM public.users u
    WHERE u.id = p_user_id AND lower(to_jsonb(u)->>'role') = 'reader'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reader account not found';
    END IF;
    IF shadow_account_lifecycle.is_account_blocked(p_user_id) THEN
        RAISE EXCEPTION 'Reader account already has an open deletion record';
    END IF;
    v_now := clock_timestamp();
    INSERT INTO shadow_account_lifecycle.deletion_records (
        user_id, requested_by, deleted_by, deleted_at, recover_until
    ) VALUES (
        p_user_id, p_requested_by, current_user, v_now,
        ((v_now AT TIME ZONE 'UTC') + interval '5 years') AT TIME ZONE 'UTC'
    ) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION shadow_account_lifecycle.restore_account(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, shadow_account_lifecycle
AS $$
DECLARE
    v_id bigint;
    v_now timestamptz;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid recovery request';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM shadow_account_lifecycle.settings WHERE singleton AND backend_ready) THEN
        RAISE EXCEPTION 'Account lifecycle is not enabled';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
    PERFORM 1 FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Original account not found. Recovery cannot proceed.';
    END IF;
    v_now := clock_timestamp();
    UPDATE shadow_account_lifecycle.deletion_records
    SET restored_at = v_now, restored_by = current_user
    WHERE user_id = p_user_id AND restored_at IS NULL AND recover_until > v_now
    RETURNING id INTO v_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No recoverable deletion record or recovery deadline expired';
    END IF;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION shadow_account_lifecycle.soft_delete_account(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION shadow_account_lifecycle.restore_account(uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
