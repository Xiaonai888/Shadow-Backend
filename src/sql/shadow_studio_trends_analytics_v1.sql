BEGIN;

CREATE TABLE IF NOT EXISTS public.shadow_studio_saved_topics (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  normalized_term text NOT NULL,
  topic text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, normalized_term),
  CONSTRAINT shadow_studio_saved_topic_length CHECK (
    char_length(topic) BETWEEN 2 AND 80
    AND char_length(normalized_term) BETWEEN 2 AND 80
  )
);

CREATE INDEX IF NOT EXISTS shadow_studio_saved_topics_recent_idx
ON public.shadow_studio_saved_topics (user_id, created_at DESC);

ALTER TABLE public.shadow_studio_saved_topics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shadow_studio_saved_topics FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_studio_saved_topics TO service_role;

CREATE OR REPLACE FUNCTION public.shadow_studio_trends_summary(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
  v_result jsonb;
BEGIN
  IF p_days IS NULL OR p_days NOT IN (7, 28, 30) THEN
    RAISE EXCEPTION 'Invalid Studio trends period' USING ERRCODE = '22023';
  END IF;

  WITH resolved_searches AS MATERIALIZED (
    SELECT
      COALESCE(g.merged_into, g.id) AS group_id,
      d.search_date,
      SUM(d.searches)::bigint AS searches
    FROM public.search_analytics_daily d
    JOIN public.search_term_groups g ON g.id = d.group_id
    WHERE d.search_date BETWEEN v_today - (p_days - 1) AND v_today
      AND d.search_type = 'all'
      AND g.status <> 'ignored'
    GROUP BY COALESCE(g.merged_into, g.id), d.search_date
  ), ranked_searches AS (
    SELECT
      r.group_id,
      g.canonical_term AS title,
      SUM(r.searches)::bigint AS searches,
      COUNT(*) FILTER (WHERE r.searches > 0)::integer AS active_days
    FROM resolved_searches r
    JOIN public.search_term_groups g ON g.id = r.group_id AND g.status = 'active'
    GROUP BY r.group_id, g.canonical_term
    HAVING SUM(r.searches) >= 10
       AND COUNT(*) FILTER (WHERE r.searches > 0) >= 2
    ORDER BY SUM(r.searches) DESC, r.group_id
    LIMIT 12
  ), recent_public_videos AS (
    SELECT v.id, v.title, v.thumbnail_url, v.published_at, v.video_type,
           v.view_count
    FROM public.fast_videos v
    WHERE v.status = 'published'
      AND v.access_type = 'free'
      AND v.published_at IS NOT NULL
      AND v.published_at <= pg_catalog.now()
      AND v.published_at >= pg_catalog.now() - pg_catalog.make_interval(days => p_days)
    ORDER BY v.published_at DESC, v.id DESC
    LIMIT 8
  ), search_json AS (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', s.group_id, 'title', s.title, 'count', s.searches
        ) ORDER BY s.searches DESC, s.group_id
      ), '[]'::jsonb
    ) AS rows
    FROM ranked_searches s
  ), recent_json AS (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', v.id, 'title', v.title,
          'thumbnail_url', v.thumbnail_url,
          'published_at', v.published_at,
          'video_type', v.video_type,
          'count', v.view_count
        ) ORDER BY v.published_at DESC, v.id DESC
      ), '[]'::jsonb
    ) AS rows
    FROM recent_public_videos v
  )
  SELECT pg_catalog.jsonb_build_object(
    'period_days', p_days,
    'generated_at', pg_catalog.now(),
    'source', 'shadow_existing_search_analytics_and_public_videos',
    'search_scope', 'shadow_sitewide_all_searches_not_video_or_youtube_searches',
    'privacy_threshold', pg_catalog.jsonb_build_object('minimum_searches', 10, 'minimum_active_days', 2),
    'topics', searches.rows,
    'top_searches', searches.rows,
    'recent_videos', videos.rows,
    'shorts_content_gaps', '[]'::jsonb,
    'shorts_content_gaps_available', false
  ) INTO v_result
  FROM search_json searches CROSS JOIN recent_json videos;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.shadow_studio_save_topic(p_owner uuid, p_topic text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_topic text := pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_topic, ''), '[[:space:]]+', ' ', 'g'));
  v_key text;
  v_count integer;
BEGIN
  IF p_owner IS NULL OR pg_catalog.char_length(v_topic) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION 'Invalid Studio saved topic' USING ERRCODE = '22023';
  END IF;

  v_key := pg_catalog.lower(v_topic);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text, 63851));

  IF EXISTS (
    SELECT 1 FROM public.shadow_studio_saved_topics
    WHERE user_id = p_owner AND normalized_term = v_key
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'saved', true, 'already_saved', true);
  END IF;

  SELECT COUNT(*)::integer INTO v_count
  FROM public.shadow_studio_saved_topics WHERE user_id = p_owner;

  IF v_count >= 30 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SAVED_TOPICS_LIMIT');
  END IF;

  INSERT INTO public.shadow_studio_saved_topics (user_id, normalized_term, topic)
  VALUES (p_owner, v_key, v_topic);

  RETURN pg_catalog.jsonb_build_object('ok', true, 'saved', true, 'already_saved', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.shadow_studio_remove_saved_topic(p_owner uuid, p_topic text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_topic text := pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(p_topic, ''), '[[:space:]]+', ' ', 'g'));
  v_count integer;
BEGIN
  IF p_owner IS NULL OR pg_catalog.char_length(v_topic) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION 'Invalid Studio saved topic' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.shadow_studio_saved_topics
  WHERE user_id = p_owner AND normalized_term = pg_catalog.lower(v_topic);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'removed', v_count > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_studio_trends_summary(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_studio_save_topic(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_studio_remove_saved_topic(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_studio_trends_summary(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_studio_save_topic(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_studio_remove_saved_topic(uuid, text) TO service_role;

COMMIT;
