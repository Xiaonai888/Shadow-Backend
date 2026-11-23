CREATE OR REPLACE FUNCTION public.smart_promotion_catalog_v1(
  p_language text,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 250,
  p_story_id uuid DEFAULT NULL
)
RETURNS TABLE (
  story_id uuid,
  story_title text,
  description text,
  cover_url text,
  story_language text,
  main_genre text,
  tags jsonb,
  story_type text,
  story_status text,
  total_views bigint,
  created_at timestamptz,
  last_episode_published_at timestamptz,
  first_episode_id uuid,
  total_episodes integer,
  locked_episode_count integer,
  promotion_eligible boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  WITH lang AS (
    SELECT
      lower(btrim(coalesce(p_language, ''))) AS code,
      CASE lower(btrim(coalesce(p_language, '')))
        WHEN 'km' THEN 'khmer'
        WHEN 'en' THEN 'english'
        WHEN 'zh' THEN 'chinese'
        WHEN 'ja' THEN 'japanese'
        WHEN 'ko' THEN 'korean'
        ELSE ''
      END AS label
  ), base AS (
    SELECT
      s.id AS story_id,
      s.title::text AS story_title,
      coalesce(s.description, '')::text AS description,
      s.cover_url::text AS cover_url,
      lang.code AS story_language,
      coalesce(s.main_genre, '')::text AS main_genre,
      coalesce(to_jsonb(s.tags), '[]'::jsonb) AS tags,
      coalesce(s.story_type::text, 'novel') AS story_type,
      coalesce(s.story_status::text, '') AS story_status,
      greatest(0, coalesce(s.total_views, 0))::bigint AS total_views,
      s.created_at::timestamptz AS created_at
    FROM public.stories AS s
    JOIN public.author_pages AS a ON a.id = s.author_id
    CROSS JOIN lang
    WHERE lang.label <> ''
      AND s.status = 'published'
      AND s.deleted_at IS NULL
      AND coalesce(s.total_episodes, 0) >= 10
      AND (s.admin_visibility_status IS NULL OR s.admin_visibility_status = 'active')
      AND coalesce(s.is_adult, false) = false
      AND coalesce(s.is_shadow_exclusive, false) = false
      AND a.status = 'active'
      AND (a.admin_status IS NULL OR a.admin_status = 'active')
      AND nullif(btrim(s.title::text), '') IS NOT NULL
      AND nullif(btrim(s.cover_url::text), '') IS NOT NULL
      AND lower(btrim(coalesce(s.story_language::text, ''))) IN (lang.code, lang.label)
      AND (p_story_id IS NULL OR s.id = p_story_id)
      AND (p_story_id IS NOT NULL OR p_after_id IS NULL OR s.id > p_after_id)
  ), published AS (
    SELECT
      b.story_id,
      e.id AS episode_id,
      coalesce(e.is_locked, false) AS is_locked,
      coalesce(e.is_free_published, false) AS is_free_published,
      coalesce(e.first_published_at, e.created_at) AS published_at,
      row_number() OVER (
        PARTITION BY b.story_id
        ORDER BY coalesce(e.first_published_at, to_timestamp(0)),
          e.episode_number, e.created_at, e.id
      ) AS published_rank
    FROM base AS b
    JOIN public.episodes AS e ON e.story_id = b.story_id
    WHERE e.status = 'published'
      AND e.deleted_at IS NULL
      AND (e.first_published_at IS NULL OR e.first_published_at <= now())
  ), totals AS (
    SELECT
      p.story_id,
      count(*)::integer AS total_episodes,
      count(*) FILTER (
        WHERE p.is_locked AND NOT p.is_free_published AND p.published_rank > 5
      )::integer AS locked_episode_count,
      (array_agg(p.episode_id ORDER BY p.published_rank))[1] AS first_episode_id,
      max(p.published_at)::timestamptz AS last_episode_published_at
    FROM published AS p
    GROUP BY p.story_id
  )
  SELECT
    b.story_id,
    b.story_title,
    b.description,
    b.cover_url,
    b.story_language,
    b.main_genre,
    b.tags,
    b.story_type,
    b.story_status,
    b.total_views,
    b.created_at,
    t.last_episode_published_at,
    t.first_episode_id,
    t.total_episodes,
    t.locked_episode_count,
    true AS promotion_eligible
  FROM base AS b
  JOIN totals AS t ON t.story_id = b.story_id
  WHERE t.locked_episode_count >= 5
  ORDER BY b.story_id ASC
  LIMIT greatest(1, least(250, coalesce(p_limit, 250)));
$function$;

REVOKE ALL ON FUNCTION public.smart_promotion_catalog_v1(text, uuid, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_promotion_catalog_v1(text, uuid, integer, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.smart_promotion_owned_v1(
  p_reader_id uuid,
  p_story_ids uuid[]
)
RETURNS TABLE (
  story_id uuid,
  owned_locked_episode_count integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  WITH published AS (
    SELECT
      e.story_id,
      e.id AS episode_id,
      coalesce(e.is_locked, false) AS is_locked,
      coalesce(e.is_free_published, false) AS is_free_published,
      row_number() OVER (
        PARTITION BY e.story_id
        ORDER BY coalesce(e.first_published_at, to_timestamp(0)),
          e.episode_number, e.created_at, e.id
      ) AS published_rank
    FROM public.episodes AS e
    WHERE e.story_id = ANY(coalesce(p_story_ids, ARRAY[]::uuid[]))
      AND e.status = 'published'
      AND e.deleted_at IS NULL
      AND (e.first_published_at IS NULL OR e.first_published_at <= now())
  )
  SELECT
    p.story_id,
    count(DISTINCT p.episode_id)::integer AS owned_locked_episode_count
  FROM published AS p
  JOIN public.episode_unlocks AS u
    ON u.episode_id = p.episode_id AND u.story_id = p.story_id
  WHERE u.user_id = p_reader_id
    AND u.unlock_status = 'active'
    AND (
      u.access_type = 'permanent'
      OR u.unlock_type IN ('diamond', 'voucher', 'story_card')
    )
    AND (u.expires_at IS NULL OR u.expires_at > now())
    AND p.is_locked
    AND NOT p.is_free_published
    AND p.published_rank > 5
  GROUP BY p.story_id;
$function$;

REVOKE ALL ON FUNCTION public.smart_promotion_owned_v1(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_promotion_owned_v1(uuid, uuid[])
  TO service_role;

CREATE TABLE IF NOT EXISTS public.smart_promotion_reader_history_v1 (
  reader_hash text NOT NULL,
  slot_key text NOT NULL,
  story_id uuid NOT NULL,
  position smallint NOT NULL DEFAULT 0,
  first_selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reader_hash, slot_key, story_id),
  CONSTRAINT smart_promotion_reader_hash_check CHECK (reader_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT smart_promotion_position_check CHECK (position >= 0 AND position < 10)
);

CREATE INDEX IF NOT EXISTS smart_promotion_reader_history_recent_idx
  ON public.smart_promotion_reader_history_v1 (reader_hash, first_selected_at DESC);

ALTER TABLE public.smart_promotion_reader_history_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.smart_promotion_reader_history_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.smart_promotion_reader_history_v1 TO service_role;

CREATE OR REPLACE FUNCTION public.smart_promotion_prune_history_v1()
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM public.smart_promotion_reader_history_v1
  WHERE first_selected_at < now() - interval '30 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;

REVOKE ALL ON FUNCTION public.smart_promotion_prune_history_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_promotion_prune_history_v1()
  TO service_role;
