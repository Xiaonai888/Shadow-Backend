CREATE INDEX IF NOT EXISTS idx_episodes_public_story_updates
ON public.episodes (published_at DESC, story_id)
WHERE deleted_at IS NULL
  AND published_at IS NOT NULL
  AND (status IS NULL OR lower(status) = 'published');

DROP FUNCTION IF EXISTS public.get_public_story_updates(
  text,
  text,
  boolean,
  integer,
  integer
);

CREATE OR REPLACE FUNCTION public.get_public_story_updates(
  p_language text DEFAULT NULL,
  p_story_type text DEFAULT NULL,
  p_include_adult boolean DEFAULT false,
  p_days integer DEFAULT 7,
  p_limit_per_day integer DEFAULT 100,
  p_story_setting text DEFAULT NULL
)
RETURNS TABLE (
  id text,
  title text,
  cover_url text,
  main_genre text,
  tags jsonb,
  story_status text,
  author_id text,
  author_name text,
  total_episodes bigint,
  update_date date,
  daily_update_count bigint,
  last_episode_published_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH limits AS (
    SELECT
      LEAST(GREATEST(COALESCE(p_days, 7), 1), 7) AS days_count,
      LEAST(GREATEST(COALESCE(p_limit_per_day, 100), 1), 100) AS per_day
  ),
  episode_updates AS (
    SELECT
      e.story_id,
      timezone(
        'Asia/Phnom_Penh',
        COALESCE(e.first_published_at, e.published_at)
      )::date AS update_date,
      COUNT(e.id)::bigint AS daily_update_count,
      MAX(COALESCE(e.first_published_at, e.published_at)) AS last_episode_published_at
    FROM public.episodes e
    CROSS JOIN limits l
    WHERE e.deleted_at IS NULL
      AND e.published_at IS NOT NULL
      AND e.published_at <= now()
      AND (
        e.status IS NULL OR
        lower(e.status) = 'published'
      )
      AND e.published_at >= (
        (timezone('Asia/Phnom_Penh', now())::date - (l.days_count - 1))::timestamp
        AT TIME ZONE 'Asia/Phnom_Penh'
      )
      AND COALESCE(e.first_published_at, e.published_at) <= now()
      AND timezone(
        'Asia/Phnom_Penh',
        COALESCE(e.first_published_at, e.published_at)
      )::date >= timezone('Asia/Phnom_Penh', now())::date - (l.days_count - 1)
    GROUP BY
      e.story_id,
      timezone(
        'Asia/Phnom_Penh',
        COALESCE(e.first_published_at, e.published_at)
      )::date
  ),
  eligible_updates AS (
    SELECT
      s.id::text AS id,
      s.title::text AS title,
      s.cover_url::text AS cover_url,
      s.main_genre::text AS main_genre,
      COALESCE(to_jsonb(s.tags), '[]'::jsonb) AS tags,
      COALESCE(s.story_status, 'New')::text AS story_status,
      s.author_id::text AS author_id,
      COALESCE(ap.page_name, ap.page_username, 'Shadow Author')::text AS author_name,
      COALESCE(s.total_episodes, 0)::bigint AS total_episodes,
      u.update_date,
      u.daily_update_count,
      u.last_episode_published_at
    FROM episode_updates u
    JOIN public.stories s ON s.id = u.story_id
    LEFT JOIN public.author_pages ap ON ap.id = s.author_id
    WHERE s.status = 'published'
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
        lower(COALESCE(s.story_type, 'novel')) = lower(trim(p_story_type))
      )
      AND (
        NULLIF(trim(p_story_setting), '') IS NULL OR
        COALESCE(s.story_settings, '{}'::text[]) @>
          ARRAY[trim(p_story_setting)]::text[]
      )
  ),
  ranked_updates AS (
    SELECT
      u.*,
      ROW_NUMBER() OVER (
        PARTITION BY u.update_date
        ORDER BY u.last_episode_published_at DESC, u.id
      ) AS day_rank
    FROM eligible_updates u
  )
  SELECT
    u.id,
    u.title,
    u.cover_url,
    u.main_genre,
    u.tags,
    u.story_status,
    u.author_id,
    u.author_name,
    u.total_episodes,
    u.update_date,
    u.daily_update_count,
    u.last_episode_published_at
  FROM ranked_updates u
  CROSS JOIN limits l
  WHERE u.day_rank <= l.per_day
  ORDER BY
    u.update_date DESC,
    u.last_episode_published_at DESC,
    u.id;
$$;

REVOKE ALL ON FUNCTION public.get_public_story_updates(
  text,
  text,
  boolean,
  integer,
  integer,
  text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_public_story_updates(
  text,
  text,
  boolean,
  integer,
  integer,
  text
) TO service_role;
