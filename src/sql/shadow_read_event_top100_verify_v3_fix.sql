WITH targets AS (
  SELECT
    expected.function_name,
    expected.signature,
    CASE
      WHEN expected.function_name = 'overall_settlement'
        AND pg_catalog.to_regprocedure('public.shadow_read_event_settle_overall_top3_legacy_v1(uuid)') IS NOT NULL
      THEN 'public.shadow_read_event_settle_overall_top3_legacy_v1(uuid)'
      ELSE expected.signature
    END AS checked_signature
  FROM (VALUES
    ('daily_leaderboard', 'public.shadow_read_event_daily_leaderboard(uuid,integer,uuid)'),
    ('overall_leaderboard', 'public.shadow_read_event_overall_leaderboard(uuid,uuid)'),
    ('daily_settlement', 'public.shadow_read_event_settle_daily_top3(uuid,integer)'),
    ('overall_settlement', 'public.shadow_read_event_settle_overall_top3(uuid)')
  ) AS expected(function_name, signature)
), definitions AS (
  SELECT
    t.function_name,
    t.checked_signature,
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(t.checked_signature)) AS definition,
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(t.signature)) AS public_definition
  FROM targets AS t
)
SELECT
  function_name,
  CASE
    WHEN definition IS NULL OR public_definition IS NULL THEN 'MISSING'
    WHEN function_name = 'overall_settlement'
      AND checked_signature <> 'public.shadow_read_event_settle_overall_top3(uuid)'
      AND pg_catalog.strpos(public_definition, 'shadow_read_event_settle_overall_top3_legacy_v1') = 0
    THEN 'WRAPPER_MISMATCH'
    WHEN function_name LIKE '%leaderboard%'
      AND pg_catalog.strpos(definition, '''top_100''') = 0
    THEN 'TOP_100_MISSING'
    WHEN pg_catalog.strpos(definition, 'c.admin_group_override') > 0
    THEN 'OLD_CLASSIFICATION_FILTER'
    WHEN pg_catalog.strpos(definition, 'p.reader_group_snapshot') = 0
    THEN 'PARTICIPANT_FILTER_MISSING'
    ELSE 'PASS'
  END AS status,
  checked_signature AS checked_function
FROM definitions
ORDER BY function_name;
