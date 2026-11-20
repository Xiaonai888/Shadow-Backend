INSERT INTO public.admin_story_growth_language_events (
  episode_id,
  story_id,
  first_published_at,
  first_published_day,
  language_code,
  record_source
)
SELECT
  e.id,
  e.story_id,
  p.first_at,
  (p.first_at AT TIME ZONE 'Asia/Phnom_Penh')::date,
  public.admin_story_growth_language_code(s.story_language),
  'backfill'
FROM public.episodes e
JOIN public.stories s ON s.id = e.story_id
CROSS JOIN LATERAL (
  SELECT COALESCE(
    e.first_published_at,
    CASE
      WHEN pg_catalog.lower(COALESCE(e.status, '')) = 'published'
      THEN e.published_at
      ELSE NULL
    END
  ) AS first_at
) p
WHERE p.first_at IS NOT NULL
  AND p.first_at <= pg_catalog.now()
ON CONFLICT (episode_id) DO NOTHING;
