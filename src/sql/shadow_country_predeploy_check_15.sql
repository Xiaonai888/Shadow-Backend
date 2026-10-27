-- SHADOW Country Settings / User Exceptions / Payout
-- Step 15: PRE-DEPLOY / READ-ONLY verification.
-- Safe to run repeatedly in Supabase SQL Editor. No INSERT/UPDATE/DELETE/DDL.
-- Execute AFTER country_settings_setup.sql and country_exception_history_setup.sql.
-- All CRITICAL checks must say PASS before deploying the History RPC routes.
-- This verifies database readiness, NOT live app behavior or the paused country policy.

WITH objects AS (
  SELECT
    to_regclass('public.shadow_country_settings') AS rules_table,
    to_regclass('public.shadow_country_user_exceptions') AS exceptions_table,
    to_regclass('public.shadow_country_exception_history') AS history_table,
    to_regprocedure('public.shadow_save_country_exception(uuid,text,jsonb,text,text)') AS save_rpc,
    to_regprocedure('public.shadow_revoke_country_exception(uuid,text,text)') AS revoke_rpc,
    to_regprocedure('public.shadow_capture_country_exception_history()') AS capture_function
), checks AS (
  SELECT 1 AS n, 'Country Rules table exists' AS test_name,
    rules_table IS NOT NULL AS passed,
    'Required by Country Settings API' AS reason FROM objects
  UNION ALL SELECT 2, 'User Exceptions table exists',
    exceptions_table IS NOT NULL,
    'Required to store per-user overrides' FROM objects
  UNION ALL SELECT 3, 'History table exists',
    history_table IS NOT NULL,
    'Run country_exception_history_setup.sql if missing' FROM objects
  UNION ALL SELECT 4, 'History has RLS enabled',
    EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = history_table AND c.relrowsecurity),
    'Blocks direct client access' FROM objects
  UNION ALL SELECT 5, 'History readable by service_role',
    COALESCE(has_table_privilege('service_role', history_table, 'SELECT'), FALSE),
    'Backend must read paginated history' FROM objects
  UNION ALL SELECT 6, 'History not writable by service_role',
    NOT COALESCE(has_table_privilege('service_role', history_table, 'INSERT,UPDATE,DELETE'), TRUE),
    'History should only be written through the SQL trigger' FROM objects
  UNION ALL SELECT 7, 'History hidden from anon',
    NOT COALESCE(has_table_privilege('anon', history_table, 'SELECT,INSERT,UPDATE,DELETE'), TRUE),
    'Anonymous clients have no direct table privileges' FROM objects
  UNION ALL SELECT 8, 'History hidden from authenticated',
    NOT COALESCE(has_table_privilege('authenticated', history_table, 'SELECT,INSERT,UPDATE,DELETE'), TRUE),
    'Reader and Author clients have no direct table privileges' FROM objects
  UNION ALL SELECT 9, 'Save Exception RPC exists',
    save_rpc IS NOT NULL,
    'Backend POST /exceptions calls this RPC' FROM objects
  UNION ALL SELECT 10, 'Revoke Exception RPC exists',
    revoke_rpc IS NOT NULL,
    'Backend DELETE /exceptions/:id calls this RPC' FROM objects
  UNION ALL SELECT 11, 'Service role can execute Save RPC',
    COALESCE(has_function_privilege('service_role', save_rpc, 'EXECUTE'), FALSE),
    'Backend needs Save RPC execution permission' FROM objects
  UNION ALL SELECT 12, 'Service role can execute Revoke RPC',
    COALESCE(has_function_privilege('service_role', revoke_rpc, 'EXECUTE'), FALSE),
    'Backend needs Revoke RPC execution permission' FROM objects
  UNION ALL SELECT 13, 'Anon cannot execute RPCs',
    NOT COALESCE(has_function_privilege('anon', save_rpc, 'EXECUTE'), TRUE)
    AND NOT COALESCE(has_function_privilege('anon', revoke_rpc, 'EXECUTE'), TRUE),
    'Prevents direct unauthenticated mutations' FROM objects
  UNION ALL SELECT 14, 'Authenticated clients cannot execute RPCs',
    NOT COALESCE(has_function_privilege('authenticated', save_rpc, 'EXECUTE'), TRUE)
    AND NOT COALESCE(has_function_privilege('authenticated', revoke_rpc, 'EXECUTE'), TRUE),
    'Prevents bypassing Admin permissions via direct RPC' FROM objects
  UNION ALL SELECT 15, 'AFTER row trigger enabled for CREATE/UPDATE/REVOKE',
    EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = exceptions_table
        AND t.tgname = 'shadow_country_exception_history_write'
        AND NOT t.tgisinternal
        AND t.tgenabled IN ('O', 'A')
        AND (t.tgtype & 1) = 1  -- FOR EACH ROW
        AND (t.tgtype & 2) = 0  -- AFTER, not BEFORE
        AND (t.tgtype & 28) = 28 -- INSERT + DELETE + UPDATE
    ),
    'A database trigger must record every change atomically' FROM objects
  UNION ALL SELECT 16, 'History capture function exists and is SECURITY DEFINER',
    EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = capture_function AND p.prosecdef),
    'Trigger writes the protected history table' FROM objects
  UNION ALL SELECT 17, 'History state shape check exists',
    EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = history_table
        AND c.conname = 'shadow_country_exception_history_states_check'
        AND c.contype = 'c'
        AND c.convalidated
    ),
    'Before and After states must match CREATE/UPDATE/REVOKE' FROM objects
  UNION ALL SELECT 18, 'History survives deleted reader/exception records',
    history_table IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = history_table AND c.contype = 'f'
    ),
    'No cascading foreign keys on the immutable history' FROM objects
  UNION ALL SELECT 19, 'History indexes installed',
    (SELECT count(*) FROM pg_indexes i WHERE i.schemaname = 'public'
      AND i.tablename = 'shadow_country_exception_history'
      AND i.indexname IN (
        'shadow_country_exception_history_recent_idx',
        'shadow_country_exception_history_user_idx',
        'shadow_country_exception_history_actor_idx'
      )) = 3,
    'Supports latest records, per-user and per-admin lookup' FROM objects
  UNION ALL SELECT 20, 'Save RPC attaches verified actor context',
    save_rpc IS NOT NULL
      AND position('shadow.country_exception_actor_id' IN COALESCE(pg_get_functiondef(save_rpc), '')) > 0
      AND position('shadow.country_exception_actor_name' IN COALESCE(pg_get_functiondef(save_rpc), '')) > 0,
    'RPC must pass Admin identity to the trigger in the same transaction' FROM objects
  UNION ALL SELECT 21, 'Revoke RPC attaches verified actor context',
    revoke_rpc IS NOT NULL
      AND position('shadow.country_exception_actor_id' IN COALESCE(pg_get_functiondef(revoke_rpc), '')) > 0
      AND position('shadow.country_exception_actor_name' IN COALESCE(pg_get_functiondef(revoke_rpc), '')) > 0,
    'Revoke history must include verified Admin identity' FROM objects
), result AS (
  SELECT n, test_name,
    CASE WHEN passed IS TRUE THEN 'PASS' ELSE 'FAIL' END AS status,
    reason
  FROM checks
)
SELECT
  n AS test_no,
  status,
  test_name,
  reason,
  (SELECT CASE WHEN COUNT(*) FILTER (WHERE status = 'FAIL') = 0
    THEN 'DATABASE READY' ELSE 'DATABASE NOT READY' END FROM result) AS overall_status
FROM result
ORDER BY n;

-- OPTIONAL: After ALL tests PASS, uncomment and run separately to inspect
-- at most 10 actual history entries. This is also read-only:
-- SELECT created_at, action, actor_admin_id, actor_name, user_id, user_name,
--        before_state, after_state
-- FROM public.shadow_country_exception_history
-- ORDER BY created_at DESC, id DESC
-- LIMIT 10;
--
-- If history is empty, that alone is not a failure: future Admin changes
-- will create records; this test never modifies user or Admin data.
-- IMPORTANT: Country Policy is intentionally OFF in
-- src/services/readerClassificationCountrySource.service.js;
-- this SQL cannot verify runtime code or complete deployment health.
