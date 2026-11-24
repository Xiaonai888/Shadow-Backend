BEGIN;

CREATE OR REPLACE FUNCTION shadow_account_lifecycle.is_account_blocked(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, shadow_account_lifecycle
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM shadow_account_lifecycle.deletion_records d
        WHERE d.user_id = p_user_id AND d.restored_at IS NULL
    );
$$;

CREATE OR REPLACE VIEW shadow_account_lifecycle.deleted_accounts AS
SELECT d.id, d.user_id, d.requested_by, d.deleted_by,
       d.deleted_at, d.recover_until, d.restored_at, d.restored_by,
       CASE
           WHEN d.restored_at IS NOT NULL THEN 'restored'
           WHEN d.recover_until <= statement_timestamp() THEN 'expired_pending_purge'
           ELSE 'recoverable'
       END AS status
FROM shadow_account_lifecycle.deletion_records d;

REVOKE ALL ON shadow_account_lifecycle.deleted_accounts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION shadow_account_lifecycle.is_account_blocked(uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
