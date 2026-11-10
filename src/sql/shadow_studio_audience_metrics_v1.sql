BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_studio_audience_summary(
  p_owner uuid,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_owner IS NULL OR p_days NOT IN (7, 28, 30) THEN
    RAISE EXCEPTION 'Invalid Studio audience parameters' USING ERRCODE = '22023';
  END IF;

  WITH observed AS MATERIALIZED (
    SELECT s.viewer_id,
           s.session_id,
           (s.last_seen_at AT TIME ZONE 'UTC')::date AS day_utc,
           v.video_type
    FROM public.fast_videos v
    JOIN public.shadow_studio_watch_sessions s ON s.video_id = v.id
    WHERE v.user_id = p_owner
      AND s.viewer_id <> p_owner
      AND s.credited_seconds > 0
      AND s.last_seen_at >= pg_catalog.now() - p_days * INTERVAL '1 day'
  ), per_viewer AS (
    SELECT viewer_id,
           COUNT(*)::bigint AS session_count,
           COUNT(DISTINCT day_utc)::bigint AS active_days,
           COALESCE(BOOL_OR(video_type = 'long'), false) AS watched_long,
           COALESCE(BOOL_OR(video_type = 'short'), false) AS watched_short
    FROM observed
    GROUP BY viewer_id
  ), totals AS (
    SELECT COUNT(*)::bigint AS observed_unique_viewers,
           COALESCE(SUM(session_count), 0)::bigint AS observed_sessions,
           COUNT(*) FILTER (WHERE active_days >= 2)::bigint AS repeat_viewers_in_period,
           COUNT(*) FILTER (WHERE watched_long AND NOT watched_short)::bigint AS long_only,
           COUNT(*) FILTER (WHERE watched_short AND NOT watched_long)::bigint AS shorts_only,
           COUNT(*) FILTER (WHERE watched_long AND watched_short)::bigint AS both_formats,
           COUNT(*) FILTER (WHERE NOT watched_long AND NOT watched_short)::bigint AS unclassified
    FROM per_viewer
  ), daily AS (
    SELECT day_utc, COUNT(DISTINCT viewer_id)::bigint AS unique_viewers
    FROM observed
    GROUP BY day_utc
  ), daily_series AS (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('day_utc', day_utc, 'unique_viewers', unique_viewers)
        ORDER BY day_utc
      ), '[]'::jsonb
    ) AS value
    FROM daily
  )
  SELECT pg_catalog.jsonb_build_object(
    'period_days', p_days,
    'generated_at', pg_catalog.now(),
    'source', 'shadow_watch_sessions',
    'scope', 'observed_qualified_shadow_playback_only',
    'coverage', pg_catalog.jsonb_build_object('complete', false, 'reason', 'recent_sessions_only'),
    'monthly_audience', pg_catalog.jsonb_build_object(
      'available', t.observed_sessions > 0 AND p_days = 30,
      'value', CASE WHEN t.observed_sessions > 0 AND p_days = 30 THEN t.observed_unique_viewers ELSE NULL END
    ),
    'unique_viewers_in_period', pg_catalog.jsonb_build_object(
      'available', t.observed_sessions > 0,
      'value', CASE WHEN t.observed_sessions > 0 THEN t.observed_unique_viewers ELSE NULL END
    ),
    'repeat_viewers_in_period', pg_catalog.jsonb_build_object(
      'available', t.observed_sessions > 0,
      'value', CASE WHEN t.observed_sessions > 0 THEN t.repeat_viewers_in_period ELSE NULL END
    ),
    'observed_sessions', pg_catalog.jsonb_build_object(
      'available', t.observed_sessions > 0,
      'value', CASE WHEN t.observed_sessions > 0 THEN t.observed_sessions ELSE NULL END
    ),
    'new_viewers', pg_catalog.jsonb_build_object('available', false, 'value', NULL),
    'casual_viewers', pg_catalog.jsonb_build_object('available', false, 'value', NULL),
    'regular_viewers', pg_catalog.jsonb_build_object('available', false, 'value', NULL),
    'returning_viewers', pg_catalog.jsonb_build_object('available', false, 'value', NULL),
    'followers', pg_catalog.jsonb_build_object('available', false, 'value', NULL),
    'viewer_groups', '[]'::jsonb,
    'online_hours', '[]'::jsonb,
    'device_types', '[]'::jsonb,
    'geographies', '[]'::jsonb,
    'ages', '[]'::jsonb,
    'genders', '[]'::jsonb,
    'subtitle_languages', '[]'::jsonb,
    'follower_watch_time', '[]'::jsonb,
    'other_content', '[]'::jsonb,
    'other_creators', '[]'::jsonb,
    'format_mix', CASE WHEN t.observed_unique_viewers >= 10 THEN
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('key', 'long_only', 'label', 'Long only', 'value', t.long_only),
        pg_catalog.jsonb_build_object('key', 'shorts_only', 'label', 'Shorts only', 'value', t.shorts_only),
        pg_catalog.jsonb_build_object('key', 'both_formats', 'label', 'Both formats', 'value', t.both_formats),
        pg_catalog.jsonb_build_object('key', 'unclassified', 'label', 'Unclassified', 'value', t.unclassified)
      ) ELSE '[]'::jsonb END,
    'daily_observed_unique', CASE WHEN t.observed_unique_viewers >= 10 THEN d.value ELSE '[]'::jsonb END
  ) INTO v_result
  FROM totals t CROSS JOIN daily_series d;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_studio_audience_summary(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_studio_audience_summary(uuid, integer) TO service_role;

COMMIT;
