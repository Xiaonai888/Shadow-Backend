WITH checks AS (
  SELECT
    expected.function_name,
    pg_catalog.to_regprocedure(expected.signature) AS function_oid
  FROM (
    VALUES
      ('daily_leaderboard', 'public.shadow_read_event_daily_leaderboard(uuid,integer,uuid)'),
      ('overall_leaderboard', 'public.shadow_read_event_overall_leaderboard(uuid,uuid)'),
      ('daily_settlement', 'public.shadow_read_event_settle_daily_top3(uuid,integer)'),
      ('overall_settlement', 'public.shadow_read_event_settle_overall_top3(uuid)')
  ) AS expected(function_name,signature)
), inspected AS (
  SELECT
    function_name,
    pg_catalog.pg_get_functiondef(function_oid) AS definition
  FROM checks
)
SELECT
  function_name,
  CASE
    WHEN definition IS NULL THEN 'MISSING'
    WHEN function_name LIKE '%leaderboard%'
      AND definition NOT LIKE '%''top_100''%' THEN 'TOP_100_MISSING'
    WHEN definition LIKE '%c.admin_group_override%' THEN 'OLD_CLASSIFICATION_FILTER'
    WHEN definition NOT LIKE '%p.reader_group_snapshot%' THEN 'PARTICIPANT_FILTER_MISSING'
    ELSE 'PASS'
  END AS status
FROM inspected
ORDER BY function_name;
