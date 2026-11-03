WITH live AS (
  SELECT
    (
      SELECT pg_catalog.pg_get_constraintdef(c.oid)
      FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = pg_catalog.to_regclass('public.shadow_read_event_weeks')
        AND c.conname = 'shadow_read_event_week_cycle_check'
      LIMIT 1
    ) AS constraint_sql,
    CASE
      WHEN pg_catalog.to_regprocedure('public.shadow_read_event_save_plan(jsonb)') IS NULL THEN NULL
      ELSE pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('public.shadow_read_event_save_plan(jsonb)')::oid
      )
    END AS save_plan_sql
), checks AS (
  SELECT
    '01_DATABASE_CONSTRAINT'::text AS check_name,
    CASE WHEN constraint_sql ~ '%[[:space:]]*14([^0-9]|$)'
           AND constraint_sql LIKE '%2026-11-02%'
         THEN 'PASS' ELSE 'FAIL' END::text AS result,
    COALESCE(constraint_sql, 'CONSTRAINT NOT FOUND')::text AS detail
  FROM live
  UNION ALL
  SELECT
    '02_SAVE_PLAN_FUNCTION',
    CASE WHEN save_plan_sql ~ '%[[:space:]]*14[[:space:]]*<>'
           AND save_plan_sql LIKE '%14-day Monday cycle%'
         THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN save_plan_sql IS NULL THEN 'FUNCTION NOT FOUND'
         WHEN save_plan_sql LIKE '%28-day Monday cycle%' THEN 'OLD 28-DAY FUNCTION STILL INSTALLED'
         ELSE 'Installed function inspected for 14-day validation' END
  FROM live
  UNION ALL
  SELECT
    '03_SAVED_EVENT_DATES',
    CASE WHEN COUNT(*) FILTER (
      WHERE starts_on < DATE '2026-11-02'
         OR (starts_on - DATE '2026-11-02') % 14 <> 0
         OR EXTRACT(ISODOW FROM starts_on) <> 1
    ) = 0 THEN 'PASS' ELSE 'FAIL' END,
    'Saved events: ' || COUNT(*)::text || '; Invalid start dates: ' ||
      COUNT(*) FILTER (
        WHERE starts_on < DATE '2026-11-02'
           OR (starts_on - DATE '2026-11-02') % 14 <> 0
           OR EXTRACT(ISODOW FROM starts_on) <> 1
      )::text
  FROM public.shadow_read_event_weeks
), calendar AS (
  SELECT
    n,
    DATE '2026-11-02' + n * 7 AS week_start
  FROM pg_catalog.generate_series(0, 7) AS g(n)
)
SELECT check_name, result, detail FROM checks
UNION ALL
SELECT
  '04_WEEK_' || (n + 1)::text,
  CASE WHEN n % 2 = 0 THEN 'EVENT' ELSE 'BREAK' END,
  week_start::text || ' to ' || (week_start + 6)::text ||
    CASE WHEN n % 2 = 0 THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM public.shadow_read_event_weeks AS w
        WHERE w.starts_on = week_start
      ) THEN ' (plan exists)' ELSE ' (plan not prepared)' END
    ELSE '' END
FROM calendar
ORDER BY check_name;
