SELECT
  COUNT(*) AS captured_episodes,
  COUNT(DISTINCT story_id) AS captured_stories,
  COUNT(*) FILTER (WHERE record_source = 'live') AS live_episodes,
  COUNT(*) FILTER (WHERE record_source = 'backfill') AS backfilled_episodes,
  MIN(first_published_day) AS earliest_day,
  MAX(first_published_day) AS latest_day
FROM public.admin_story_growth_language_events;

SELECT
  COALESCE(language_code, 'unknown') AS story_language,
  COUNT(*) AS episodes,
  COUNT(DISTINCT story_id) AS stories
FROM public.admin_story_growth_language_events
GROUP BY language_code
ORDER BY language_code NULLS LAST;

SELECT
  lang.code AS language,
  result.snapshot ->> 'as_of' AS as_of,
  result.snapshot ->> 'history_quality' AS history_quality,
  pg_catalog.jsonb_array_length(result.snapshot -> 'days') AS day_count,
  (
    SELECT COALESCE(SUM((d.value ->> 'new_episodes')::bigint), 0)
    FROM pg_catalog.jsonb_array_elements(result.snapshot -> 'days') AS d(value)
  ) AS episodes_in_365_days
FROM (VALUES ('km'), ('en'), ('zh'), ('ja'), ('ko')) AS lang(code)
CROSS JOIN LATERAL (
  SELECT public.get_admin_story_growth_language_daily(lang.code) AS snapshot
) AS result
ORDER BY lang.code;

SELECT
  tgname AS trigger_name,
  tgenabled AS enabled
FROM pg_catalog.pg_trigger
WHERE tgrelid = 'public.episodes'::regclass
  AND tgname = 'admin_story_growth_language_event_capture';
