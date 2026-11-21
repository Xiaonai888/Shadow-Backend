WITH bounds AS (
  SELECT
    ((pg_catalog.now() AT TIME ZONE 'Asia/Phnom_Penh')::date - 6)::timestamp AT TIME ZONE 'Asia/Phnom_Penh' AS start_at,
    (((pg_catalog.now() AT TIME ZONE 'Asia/Phnom_Penh')::date + 1)::timestamp) AT TIME ZONE 'Asia/Phnom_Penh' AS end_at
), source_counts AS (
  SELECT
    COUNT(*) AS source_episodes,
    COUNT(DISTINCT e.story_id) AS source_stories,
    COUNT(DISTINCT s.author_id) AS source_authors,
    COUNT(*) FILTER (
      WHERE public.admin_story_growth_language_code(s.story_language) IS NULL
    ) AS episodes_unknown_language
  FROM bounds b
  JOIN public.episodes e
    ON e.first_published_at >= b.start_at
   AND e.first_published_at < b.end_at
   AND e.status = 'published'
   AND e.deleted_at IS NULL
  JOIN public.stories s ON s.id = e.story_id AND s.deleted_at IS NULL
  JOIN public.author_pages a ON a.id = s.author_id
), result AS (
  SELECT public.get_admin_story_update_activity_v2(
    b.start_at, b.end_at,
    'episodes', 1, 10, '', 'all', 'all', 'all'
  ) AS value
  FROM bounds b
)
SELECT
  s.source_episodes,
  (r.value -> 'summary' ->> 'new_episodes')::bigint AS rpc_episodes,
  s.source_stories,
  (r.value -> 'summary' ->> 'updated_stories')::bigint AS rpc_stories,
  s.source_authors,
  (r.value -> 'summary' ->> 'active_authors')::bigint AS rpc_authors,
  s.episodes_unknown_language,
  (
    s.source_episodes = (r.value -> 'summary' ->> 'new_episodes')::bigint
    AND s.source_stories = (r.value -> 'summary' ->> 'updated_stories')::bigint
    AND s.source_authors = (r.value -> 'summary' ->> 'active_authors')::bigint
  ) AS all_counts_match
FROM source_counts s
CROSS JOIN result r;
