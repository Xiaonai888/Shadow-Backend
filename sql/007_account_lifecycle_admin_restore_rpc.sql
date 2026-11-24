BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_deleted_account_restore(
    p_record_id bigint,
    p_admin_id text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, shadow_account_lifecycle
AS $$
DECLARE
    v_user_id uuid;
    v_restored_id bigint;
BEGIN
    IF p_record_id IS NULL OR p_admin_id IS NULL OR length(btrim(p_admin_id)) = 0 OR length(p_admin_id) > 128 THEN
        RAISE EXCEPTION 'Invalid recovery request';
    END IF;

    SELECT user_id INTO v_user_id
    FROM shadow_account_lifecycle.deletion_records
    WHERE id = p_record_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Deletion record not found';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

    IF NOT EXISTS (
        SELECT 1 FROM shadow_account_lifecycle.deletion_records
        WHERE id = p_record_id AND user_id = v_user_id
          AND restored_at IS NULL AND recover_until > clock_timestamp()
    ) THEN
        RAISE EXCEPTION 'Deletion record is no longer recoverable';
    END IF;

    v_restored_id := shadow_account_lifecycle.restore_account(v_user_id);

    IF v_restored_id IS DISTINCT FROM p_record_id THEN
        RAISE EXCEPTION 'Deletion record changed';
    END IF;

    UPDATE shadow_account_lifecycle.deletion_records
    SET restored_by = 'admin:' || btrim(p_admin_id)
    WHERE id = v_restored_id;

    RETURN v_restored_id;
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_deleted_account_restore(bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shadow_deleted_account_restore(bigint, text) TO service_role;

COMMIT;
