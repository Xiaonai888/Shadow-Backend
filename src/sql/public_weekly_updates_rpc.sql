CREATE INDEX IF NOT EXISTS idx_episodes_public_weekly_updates
ON public.episodes (published_at DESC, story_id)
WHERE deleted_at IS NULL
  AND published_at IS NOT NULL
  AND (status IS NULL OR lower(status) = 'published');

CREATE OR REPLACE FUNCTION public.get_public_weekly_story_updates(
  p_language text DEFAULT NULL,
  p_story_type text DEFAULT NULL,
  p_include_adult boolean DEFAULT false,
  p_limit integer DEFAULT 6
)
RETURNS TABLE (
  id uuid,
  title text,
  cover_url text,
  landscape_thumbnail_url text,
  weekly_update_count bigint,
  last_episode_published_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH week_bounds AS (
    SELECT
      (
        date_trunc(
          'week',
          timezone('Asia/Phnom_Penh', now())
        ) AT TIME ZONE 'Asia/Phnom_Penh'
      ) AS week_start,
      (
        date_trunc(
          'week',
          timezone('Asia/Phnom_Penh', now())
        ) AT TIME ZONE 'Asia/Phnom_Penh'
      ) + interval '7 days' AS week_end
  )
  SELECT
    s.id,
    s.title,
    s.cover_url,
    s.landscape_thumbnail_url,
    COUNT(e.id)::bigint AS weekly_update_count,
    MAX(e.published_at) AS last_episode_published_at
  FROM public.episodes e
  JOIN public.stories s
    ON s.id = e.story_id
  CROSS JOIN week_bounds bounds
  WHERE e.deleted_at IS NULL
    AND e.published_at IS NOT NULL
    AND e.published_at >= bounds.week_start
    AND e.published_at < bounds.week_end
    AND e.published_at <= now()
    AND (
      e.status IS NULL OR
      lower(e.status) = 'published'
    )
    AND s.status = 'published'
    AND s.deleted_at IS NULL
    AND COALESCE(s.is_shadow_exclusive, false) = false
    AND (
      p_include_adult OR
      COALESCE(s.is_adult, false) = false
    )
    AND (
      NULLIF(trim(p_language), '') IS NULL OR
      s.story_language = trim(p_language)
    )
    AND (
      NULLIF(trim(p_story_type), '') IS NULL OR
      lower(COALESCE(s.story_type, 'novel')) =
        lower(trim(p_story_type))
    )
  GROUP BY
    s.id,
    s.title,
    s.cover_url,
    s.landscape_thumbnail_url
  ORDER BY
    weekly_update_count DESC,
    last_episode_published_at DESC
  LIMIT LEAST(
    GREATEST(COALESCE(p_limit, 6), 1),
    24
  );
$$;

REVOKE ALL ON FUNCTION public.get_public_weekly_story_updates(
  text,
  text,
  boolean,
  integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_public_weekly_story_updates(
  text,
  text,
  boolean,
  integer
) TO service_role;
