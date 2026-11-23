WITH objects AS (
  SELECT
    to_regclass('public.smart_pdf_reader_exposure') AS reader_table,
    to_regclass('public.smart_pdf_product_exposure_totals') AS totals_table,
    to_regclass('public.smart_pdf_reader_exposure_recent_idx') AS recent_index,
    to_regprocedure('public.smart_pdf_record_events_v1(text,text,text,text,uuid[])') AS record_function,
    to_regprocedure('public.smart_pdf_prune_exposure_v1()') AS prune_function
), checks AS (
  SELECT '01_reader_exposure_table' AS check_name,
    reader_table IS NOT NULL AS passed,
    'Run sql/20261123_smart_pdf_exposure.sql if missing' AS details FROM objects
  UNION ALL SELECT '02_product_totals_table',
    totals_table IS NOT NULL,
    'Product impression/click counters' FROM objects
  UNION ALL SELECT '03_reader_recent_index',
    recent_index IS NOT NULL,
    'Reader exposure history index' FROM objects
  UNION ALL SELECT '04_reader_table_rls',
    COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = reader_table), false),
    'Row-level security must be enabled' FROM objects
  UNION ALL SELECT '05_totals_table_rls',
    COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = totals_table), false),
    'Row-level security must be enabled' FROM objects
  UNION ALL SELECT '06_reader_anonymous_read_denied',
    NOT COALESCE(has_table_privilege('anon', reader_table, 'SELECT'), true),
    'The anonymous role must not directly read reader hashes' FROM objects
  UNION ALL SELECT '07_reader_authenticated_read_denied',
    NOT COALESCE(has_table_privilege('authenticated', reader_table, 'SELECT'), true),
    'The authenticated role must not directly read reader hashes' FROM objects
  UNION ALL SELECT '08_totals_anonymous_read_denied',
    NOT COALESCE(has_table_privilege('anon', totals_table, 'SELECT'), true),
    'The anonymous role must not directly read counters' FROM objects
  UNION ALL SELECT '09_reader_service_role_read',
    COALESCE(has_table_privilege('service_role', reader_table, 'SELECT'), false),
    'Backend service role requires SELECT' FROM objects
  UNION ALL SELECT '10_reader_service_role_write',
    COALESCE(has_table_privilege('service_role', reader_table, 'INSERT'), false)
      AND COALESCE(has_table_privilege('service_role', reader_table, 'UPDATE'), false),
    'Backend event writer requires INSERT and UPDATE' FROM objects
  UNION ALL SELECT '11_totals_service_role_read',
    COALESCE(has_table_privilege('service_role', totals_table, 'SELECT'), false),
    'Backend counters reader requires SELECT' FROM objects
  UNION ALL SELECT '12_record_function_exists',
    record_function IS NOT NULL,
    'smart_pdf_record_events_v1(text,text,text,text,uuid[])' FROM objects
  UNION ALL SELECT '13_record_function_security_definer',
    COALESCE((SELECT prosecdef FROM pg_proc WHERE oid = record_function), false),
    'Event function must be SECURITY DEFINER' FROM objects
  UNION ALL SELECT '14_record_service_role_allowed',
    COALESCE(has_function_privilege('service_role', record_function, 'EXECUTE'), false),
    'Backend must be allowed to record events' FROM objects
  UNION ALL SELECT '15_record_anon_execute_denied',
    NOT COALESCE(has_function_privilege('anon', record_function, 'EXECUTE'), true),
    'Anonymous clients must not call event RPC' FROM objects
  UNION ALL SELECT '16_record_auth_execute_denied',
    NOT COALESCE(has_function_privilege('authenticated', record_function, 'EXECUTE'), true),
    'Authenticated clients must not call event RPC directly' FROM objects
  UNION ALL SELECT '17_prune_function_exists',
    prune_function IS NOT NULL,
    'smart_pdf_prune_exposure_v1()' FROM objects
  UNION ALL SELECT '18_prune_service_role_allowed',
    COALESCE(has_function_privilege('service_role', prune_function, 'EXECUTE'), false),
    'Backend or service scheduler may prune old exposure' FROM objects
  UNION ALL SELECT '19_prune_anon_execute_denied',
    NOT COALESCE(has_function_privilege('anon', prune_function, 'EXECUTE'), true),
    'Anonymous clients must not prune exposure' FROM objects
  UNION ALL SELECT '20_reader_required_columns',
    (SELECT COUNT(*) FROM pg_attribute
      WHERE attrelid = reader_table AND attname = ANY(ARRAY['reader_hash','product_id','slot_key','placement','impressions','clicks','last_seen_at'])
        AND NOT attisdropped) = 7,
    'Reader exposure schema matches the backend' FROM objects
  UNION ALL SELECT '21_totals_required_columns',
    (SELECT COUNT(*) FROM pg_attribute
      WHERE attrelid = totals_table AND attname = ANY(ARRAY['product_id','impressions','clicks'])
        AND NOT attisdropped) = 3,
    'Totals exposure schema matches the backend' FROM objects
)
SELECT check_name,
  CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS status,
  details
FROM checks
ORDER BY check_name;
