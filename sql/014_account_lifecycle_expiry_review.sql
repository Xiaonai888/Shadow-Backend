BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';

CREATE TABLE IF NOT EXISTS shadow_account_lifecycle.expiry_purge_review (
    deletion_record_id bigint PRIMARY KEY,
    queued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE shadow_account_lifecycle.expiry_purge_review ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE shadow_account_lifecycle.expiry_purge_review
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION shadow_account_lifecycle.enqueue_expired_purge_reviews()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO pg_catalog
AS $function$
DECLARE
    v_count integer;
BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtextextended('shadow_account_lifecycle.expiry_purge_review', 0)) THEN
        RETURN 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM shadow_account_lifecycle.settings
        WHERE singleton AND backend_ready
    ) THEN
        RETURN 0;
    END IF;

    INSERT INTO shadow_account_lifecycle.expiry_purge_review (deletion_record_id)
    SELECT d.id
    FROM shadow_account_lifecycle.deletion_records d
    WHERE d.restored_at IS NULL
      AND d.recover_until <= statement_timestamp()
      AND NOT EXISTS (
          SELECT 1 FROM shadow_account_lifecycle.expiry_purge_review q
          WHERE q.deletion_record_id = d.id
      )
    ORDER BY d.recover_until, d.id
    LIMIT 50
    ON CONFLICT (deletion_record_id) DO NOTHING;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION shadow_account_lifecycle.enqueue_expired_purge_reviews()
FROM PUBLIC, anon, authenticated, service_role;

SELECT cron.schedule(
    'shadow-account-expiry-review-v1',
    '17 20 * * *',
    'SELECT shadow_account_lifecycle.enqueue_expired_purge_reviews();'
);

DO $verify$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM cron.job
        WHERE jobname = 'shadow-account-expiry-review-v1'
          AND username = current_user
          AND active
          AND schedule = '17 20 * * *'
          AND command = 'SELECT shadow_account_lifecycle.enqueue_expired_purge_reviews();'
    ) THEN
        RAISE EXCEPTION 'Expiry review schedule verification failed';
    END IF;

    IF has_function_privilege('anon', 'shadow_account_lifecycle.enqueue_expired_purge_reviews()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'shadow_account_lifecycle.enqueue_expired_purge_reviews()', 'EXECUTE')
       OR has_function_privilege('service_role', 'shadow_account_lifecycle.enqueue_expired_purge_reviews()', 'EXECUTE') THEN
        RAISE EXCEPTION 'Unexpected expiry review function permission';
    END IF;
END;
$verify$;

COMMIT;

SELECT
    EXISTS (
        SELECT 1 FROM cron.job
        WHERE jobname = 'shadow-account-expiry-review-v1'
          AND username = current_user AND active
    ) AS expiry_review_scheduled,
    (SELECT count(*) FROM shadow_account_lifecycle.expired_accounts_queue) AS expired_accounts,
    (SELECT count(*) FROM shadow_account_lifecycle.expiry_purge_review) AS queued_reviews,
    false AS permanent_delete_enabled;
