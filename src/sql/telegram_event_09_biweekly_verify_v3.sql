WITH checks AS (
  SELECT 'first_active_week' AS test, (public.telegram_event_next_publish_v1('biweekly','[{"day":0,"time":"08:00"}]'::jsonb,DATE '2026-11-29',NULL,TIMESTAMPTZ '2026-11-28 12:00+07') = TIMESTAMPTZ '2026-11-29 08:00+07') AS passed
  UNION ALL
  SELECT 'strict_after_skips_rest_week' AS test, (public.telegram_event_next_publish_v1('biweekly','[{"day":0,"time":"08:00"}]'::jsonb,DATE '2026-11-29',NULL,TIMESTAMPTZ '2026-11-29 08:00+07') = TIMESTAMPTZ '2026-12-13 08:00+07') AS passed
  UNION ALL
  SELECT 'rest_week' AS test, (public.telegram_event_next_publish_v1('biweekly','[{"day":0,"time":"08:00"}]'::jsonb,DATE '2026-11-29',NULL,TIMESTAMPTZ '2026-12-06 07:00+07') = TIMESTAMPTZ '2026-12-13 08:00+07') AS passed
  UNION ALL
  SELECT 'second_slot_same_day' AS test, (public.telegram_event_next_publish_v1('biweekly','[{"day":0,"time":"08:00"},{"day":0,"time":"18:00"},{"day":3,"time":"09:00"}]'::jsonb,DATE '2026-11-29',NULL,TIMESTAMPTZ '2026-11-29 08:00+07') = TIMESTAMPTZ '2026-11-29 18:00+07') AS passed
  UNION ALL
  SELECT 'multiple_weekdays' AS test, (public.telegram_event_next_publish_v1('biweekly','[{"day":0,"time":"08:00"},{"day":0,"time":"18:00"},{"day":3,"time":"09:00"}]'::jsonb,DATE '2026-11-29',NULL,TIMESTAMPTZ '2026-11-29 18:00+07') = TIMESTAMPTZ '2026-12-02 09:00+07') AS passed
  UNION ALL
  SELECT 'end_in_rest_week' AS test, (public.telegram_event_next_publish_v1('biweekly','[{"day":0,"time":"08:00"}]'::jsonb,DATE '2026-11-29',DATE '2026-12-06',TIMESTAMPTZ '2026-11-29 08:00+07') IS NULL) AS passed
  UNION ALL
  SELECT 'inclusive_end' AS test, (public.telegram_event_next_publish_v1('biweekly','[{"day":0,"time":"08:00"}]'::jsonb,DATE '2026-11-29',DATE '2026-12-13',TIMESTAMPTZ '2026-12-13 07:00+07') = TIMESTAMPTZ '2026-12-13 08:00+07') AS passed
  UNION ALL
  SELECT 'forever_anchor_across_year' AS test, (public.telegram_event_next_publish_v1('biweekly','[{"day":0,"time":"08:00"}]'::jsonb,DATE '2026-11-29',NULL,TIMESTAMPTZ '2027-01-03 07:00+07') = TIMESTAMPTZ '2027-01-10 08:00+07') AS passed
  UNION ALL
  SELECT 'midweek_anchor' AS test, (public.telegram_event_next_publish_v1('biweekly','[{"day":0,"time":"08:00"}]'::jsonb,DATE '2026-12-02',NULL,TIMESTAMPTZ '2026-12-07 00:00+07') = TIMESTAMPTZ '2026-12-20 08:00+07') AS passed
  UNION ALL
  SELECT 'weekly_unchanged' AS test, (public.telegram_event_next_publish_v1('weekly','[{"day":0,"time":"08:00"}]'::jsonb,DATE '2026-11-29',NULL,TIMESTAMPTZ '2026-11-29 08:00+07') = TIMESTAMPTZ '2026-12-06 08:00+07') AS passed
  UNION ALL
  SELECT 'specific_date_unchanged' AS test, (public.telegram_event_next_publish_v1('dates','[{"date":"2026-11-29","time":"08:00"}]'::jsonb,NULL,NULL,TIMESTAMPTZ '2026-11-29 07:00+07') = TIMESTAMPTZ '2026-11-29 08:00+07') AS passed
  UNION ALL
  SELECT 'missing_anchor_rejected' AS test, (NOT public.telegram_event_schedule_valid_v1('biweekly','[{"day":0,"time":"08:00"}]'::jsonb,NULL,NULL)) AS passed
  UNION ALL
  SELECT 'invalid_end_rejected' AS test, (NOT public.telegram_event_schedule_valid_v1('biweekly','[{"day":0,"time":"08:00"}]'::jsonb,DATE '2026-11-29',DATE '2026-11-28')) AS passed
  UNION ALL
  SELECT 'duplicate_slots_rejected' AS test, (NOT public.telegram_event_schedule_valid_v1('biweekly','[{"day":0,"time":"08:00"},{"day":0,"time":"08:00"}]',DATE '2026-11-29',NULL)) AS passed
  UNION ALL
  SELECT 'mode_constraint' AS test, (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.telegram_events'::regclass AND conname='telegram_events_schedule_mode_check' AND convalidated AND pg_get_constraintdef(oid) LIKE '%biweekly%')) AS passed
  UNION ALL
  SELECT 'function_permissions' AS test, (NOT has_function_privilege('anon','public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz)','EXECUTE') AND NOT has_function_privilege('authenticated','public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz)','EXECUTE') AND has_function_privilege('service_role','public.telegram_event_next_publish_v1(text,jsonb,date,date,timestamptz)','EXECUTE')) AS passed
) SELECT test, CASE WHEN passed IS TRUE THEN 'PASS' ELSE 'FAIL' END AS result FROM checks ORDER BY test;
