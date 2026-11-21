WITH days AS (
  SELECT
    ((pg_catalog.now() AT TIME ZONE 'Asia/Phnom_Penh')::date)::timestamp AT TIME ZONE 'Asia/Phnom_Penh' AS start_at,
    (((pg_catalog.now() AT TIME ZONE 'Asia/Phnom_Penh')::date + 1)::timestamp) AT TIME ZONE 'Asia/Phnom_Penh' AS end_at
), languages(code) AS (
  VALUES ('all'), ('km'), ('en'), ('zh'), ('ja'), ('ko')
), results AS (
  SELECT
    l.code,
    public.get_admin_story_update_activity_v2(
      d.start_at,
      d.end_at,
      'episodes',
      1,
      10,
      '',
      'all',
      l.code,
      'all'
    ) AS snapshot
  FROM languages l
  CROSS JOIN days d
)
SELECT
  code AS language,
  pg_catalog.jsonb_typeof(snapshot -> 'summary') AS summary_type,
  (snapshot -> 'summary' ->> 'active_authors')::bigint AS active_authors,
  (snapshot -> 'summary' ->> 'updated_stories')::bigint AS updated_stories,
  (snapshot -> 'summary' ->> 'new_episodes')::bigint AS new_episodes,
  pg_catalog.jsonb_array_length(snapshot -> 'authors') AS returned_authors,
  (snapshot ->> 'total')::bigint AS total_authors,
  (snapshot ->> 'total_pages')::integer AS total_pages,
  (snapshot ->> 'page')::integer AS current_page,
  (snapshot ->> 'limit')::integer AS page_size,
  pg_catalog.jsonb_typeof(snapshot -> 'filter_options') AS filter_options_type
FROM results
ORDER BY CASE code
  WHEN 'all' THEN 0
  WHEN 'km' THEN 1
  WHEN 'en' THEN 2
  WHEN 'zh' THEN 3
  WHEN 'ja' THEN 4
  WHEN 'ko' THEN 5
  ELSE 6
END;

SELECT
  p.proname AS rpc,
  NOT p.prosecdef AS security_invoker,
  pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_executes,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_executes,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_executes
FROM pg_catalog.pg_proc p
WHERE p.oid = 'public.get_admin_story_update_activity_v2(timestamptz,timestamptz,text,integer,integer,text,text,text,text)'::regprocedure;
