WITH expected_tables(name) AS (
  VALUES ('telegram_events'), ('telegram_event_contents'), ('telegram_event_channels'), ('telegram_event_history')
), checks AS (
  SELECT 'table_rls_' || e.name AS test_name,
    coalesce(c.relrowsecurity, false) AS passed
  FROM expected_tables e LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || e.name)
  UNION ALL
  SELECT 'private_' || name,
    NOT has_table_privilege('anon', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('authenticated', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE')
    AND has_table_privilege('service_role', 'public.' || name, 'SELECT')
    AND has_table_privilege('service_role', 'public.' || name, 'INSERT')
    AND has_table_privilege('service_role', 'public.' || name, 'UPDATE')
    AND has_table_privilege('service_role', 'public.' || name, 'DELETE')
  FROM expected_tables
  UNION ALL
  SELECT 'five_language_rows', (SELECT count(*) = 5 AND count(*) FILTER (WHERE language IN ('km','en','zh','ko','ja')) = 5 FROM public.telegram_event_channels)
  UNION ALL
  SELECT 'channels_initially_disabled', NOT EXISTS (SELECT 1 FROM public.telegram_event_channels WHERE enabled OR channel_id IS NOT NULL)
  UNION ALL
  SELECT 'due_index_exists', to_regclass('public.telegram_events_due_idx') IS NOT NULL
  UNION ALL
  SELECT 'slot_unique_index_exists', coalesce((SELECT indisunique FROM pg_index WHERE indexrelid = to_regclass('public.telegram_event_history_slot_idx')), false)
  UNION ALL
  SELECT 'weekly_forever', public.telegram_event_next_publish_v1('weekly','[{"day":0,"time":"08:00"}]',DATE '2026-11-29',NULL,TIMESTAMPTZ '2026-11-29 01:00:00+00') IS NOT DISTINCT FROM TIMESTAMPTZ '2026-12-06 01:00:00+00'
  UNION ALL
  SELECT 'weekly_same_day_second_slot', public.telegram_event_next_publish_v1('weekly','[{"day":0,"time":"18:00"},{"day":0,"time":"08:00"}]',DATE '2026-11-29',NULL,TIMESTAMPTZ '2026-11-29 01:00:00+00') IS NOT DISTINCT FROM TIMESTAMPTZ '2026-11-29 11:00:00+00'
  UNION ALL
  SELECT 'weekly_inclusive_end', public.telegram_event_next_publish_v1('weekly','[{"day":0,"time":"08:00"}]',DATE '2026-11-29',DATE '2026-11-29',TIMESTAMPTZ '2026-11-28 23:59:00+00') IS NOT DISTINCT FROM TIMESTAMPTZ '2026-11-29 01:00:00+00'
  UNION ALL
  SELECT 'weekly_expired', public.telegram_event_next_publish_v1('weekly','[{"day":0,"time":"08:00"}]',DATE '2026-11-29',DATE '2026-11-29',TIMESTAMPTZ '2026-11-29 01:00:00+00') IS NULL
  UNION ALL
  SELECT 'weekly_future_start', public.telegram_event_next_publish_v1('weekly','[{"day":0,"time":"08:00"}]',DATE '2026-12-06',NULL,TIMESTAMPTZ '2026-11-27 00:00:00+00') IS NOT DISTINCT FROM TIMESTAMPTZ '2026-12-06 01:00:00+00'
  UNION ALL
  SELECT 'specific_dates_unsorted', public.telegram_event_next_publish_v1('dates','[{"date":"2026-12-02","time":"09:00"},{"date":"2026-12-01","time":"18:00"}]',NULL,NULL,TIMESTAMPTZ '2026-11-30 23:00:00+00') IS NOT DISTINCT FROM TIMESTAMPTZ '2026-12-01 11:00:00+00'
  UNION ALL
  SELECT 'specific_dates_finished', public.telegram_event_next_publish_v1('dates','[{"date":"2026-12-01","time":"18:00"}]',NULL,NULL,TIMESTAMPTZ '2026-12-01 11:00:00+00') IS NULL
  UNION ALL
  SELECT 'local_midnight', public.telegram_event_next_publish_v1('dates','[{"date":"2026-12-01","time":"00:00"}]',NULL,NULL,TIMESTAMPTZ '2026-11-30 16:59:00+00') IS NOT DISTINCT FROM TIMESTAMPTZ '2026-11-30 17:00:00+00'
  UNION ALL
  SELECT 'duplicate_rejected', NOT public.telegram_event_schedule_valid_v1('weekly','[{"day":0,"time":"08:00"},{"day":0,"time":"08:00"}]',DATE '2026-11-29',NULL)
  UNION ALL
  SELECT 'invalid_date_rejected', NOT public.telegram_event_schedule_valid_v1('dates','[{"date":"2026-02-30","time":"08:00"}]',NULL,NULL)
  UNION ALL
  SELECT 'invalid_time_rejected', NOT public.telegram_event_schedule_valid_v1('weekly','[{"day":0,"time":"24:00"}]',DATE '2026-11-29',NULL)
  UNION ALL
  SELECT 'invalid_weekday_rejected', NOT public.telegram_event_schedule_valid_v1('weekly','[{"day":7,"time":"08:00"}]',DATE '2026-11-29',NULL)
  UNION ALL
  SELECT 'missing_time_rejected', NOT public.telegram_event_schedule_valid_v1('weekly','[{"day":0}]',DATE '2026-11-29',NULL)
  UNION ALL
  SELECT 'reversed_range_rejected', NOT public.telegram_event_schedule_valid_v1('weekly','[{"day":0,"time":"08:00"}]',DATE '2026-12-06',DATE '2026-11-29')
  UNION ALL
  SELECT 'anonymous_rpc_denied', NOT has_function_privilege('anon','public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz)','EXECUTE')
    AND has_function_privilege('service_role','public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz)','EXECUTE')
)
SELECT test_name, CASE WHEN passed IS TRUE THEN 'PASS' ELSE 'FAIL' END AS result FROM checks ORDER BY test_name;
