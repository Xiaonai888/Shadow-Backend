BEGIN;

CREATE TABLE IF NOT EXISTS public.shadow_studio_video_daily_metrics (
  video_id uuid NOT NULL REFERENCES public.fast_videos(id) ON DELETE CASCADE,
  day_utc date NOT NULL,
  watch_seconds numeric(16,3) NOT NULL DEFAULT 0 CHECK (watch_seconds >= 0),
  playback_updates bigint NOT NULL DEFAULT 0 CHECK (playback_updates >= 0),
  thumbnail_impressions bigint NOT NULL DEFAULT 0 CHECK (thumbnail_impressions >= 0),
  thumbnail_clicks bigint NOT NULL DEFAULT 0 CHECK (thumbnail_clicks >= 0),
  PRIMARY KEY (video_id, day_utc)
);

CREATE INDEX IF NOT EXISTS shadow_studio_daily_metrics_period_idx
ON public.shadow_studio_video_daily_metrics (day_utc, video_id);

CREATE TABLE IF NOT EXISTS public.shadow_studio_video_monthly_metrics (
  video_id uuid NOT NULL REFERENCES public.fast_videos(id) ON DELETE CASCADE,
  month_utc date NOT NULL,
  watch_seconds numeric(18,3) NOT NULL DEFAULT 0 CHECK (watch_seconds >= 0),
  playback_updates bigint NOT NULL DEFAULT 0 CHECK (playback_updates >= 0),
  thumbnail_impressions bigint NOT NULL DEFAULT 0 CHECK (thumbnail_impressions >= 0),
  thumbnail_clicks bigint NOT NULL DEFAULT 0 CHECK (thumbnail_clicks >= 0),
  PRIMARY KEY (video_id, month_utc)
);

CREATE TABLE IF NOT EXISTS public.shadow_studio_watch_sessions (
  video_id uuid NOT NULL REFERENCES public.fast_videos(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL,
  session_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_played_seconds numeric(12,3) NOT NULL DEFAULT 0 CHECK (last_played_seconds >= 0),
  credited_seconds numeric(12,3) NOT NULL DEFAULT 0 CHECK (credited_seconds >= 0),
  PRIMARY KEY (video_id, viewer_id, session_id)
);

CREATE INDEX IF NOT EXISTS shadow_studio_watch_sessions_expiry_idx
ON public.shadow_studio_watch_sessions (last_seen_at);

CREATE INDEX IF NOT EXISTS shadow_studio_watch_sessions_video_recent_idx
ON public.shadow_studio_watch_sessions (video_id, last_seen_at);

CREATE TABLE IF NOT EXISTS public.shadow_studio_thumbnail_dedup (
  video_id uuid NOT NULL REFERENCES public.fast_videos(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL,
  day_utc date NOT NULL,
  surface text NOT NULL CHECK (surface IN ('search', 'discover', 'profile', 'author', 'related')),
  action text NOT NULL CHECK (action IN ('impression', 'click')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, viewer_id, day_utc, surface, action)
);

CREATE INDEX IF NOT EXISTS shadow_studio_thumbnail_dedup_expiry_idx
ON public.shadow_studio_thumbnail_dedup (day_utc);

ALTER TABLE public.shadow_studio_video_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_studio_video_monthly_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_studio_watch_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_studio_thumbnail_dedup ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.shadow_studio_video_daily_metrics FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.shadow_studio_video_monthly_metrics FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.shadow_studio_watch_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.shadow_studio_thumbnail_dedup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_studio_video_daily_metrics TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_studio_video_monthly_metrics TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_studio_watch_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_studio_thumbnail_dedup TO service_role;

CREATE OR REPLACE FUNCTION public.shadow_studio_record_watch(
  p_video_id uuid,
  p_viewer_id uuid,
  p_session_id uuid,
  p_kind text,
  p_played_seconds numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_last_seen timestamptz;
  v_started_at timestamptz;
  v_last_played numeric;
  v_credited numeric;
  v_delta numeric := 0;
  v_elapsed numeric;
  v_day date;
  v_month date;
BEGIN
  IF p_viewer_id IS NULL OR p_video_id IS NULL OR p_session_id IS NULL
    OR p_kind IS NULL OR p_kind NOT IN ('start', 'progress', 'end')
    OR p_played_seconds IS NULL OR p_played_seconds < 0 OR p_played_seconds > 43200 THEN
    RAISE EXCEPTION 'Invalid playback event' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.fast_videos v
    WHERE v.id = p_video_id AND v.user_id <> p_viewer_id
      AND v.status = 'published' AND v.access_type = 'free'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_eligible');
  END IF;

  IF p_kind = 'start' THEN
    INSERT INTO public.shadow_studio_watch_sessions
      (video_id, viewer_id, session_id, started_at, last_seen_at)
    VALUES (p_video_id, p_viewer_id, p_session_id, v_now, v_now)
    ON CONFLICT DO NOTHING;
    RETURN pg_catalog.jsonb_build_object('ok', true, 'credited_seconds', 0);
  END IF;

  SELECT s.last_seen_at, s.started_at, s.last_played_seconds, s.credited_seconds
    INTO v_last_seen, v_started_at, v_last_played, v_credited
  FROM public.shadow_studio_watch_sessions s
  WHERE s.video_id = p_video_id AND s.viewer_id = p_viewer_id AND s.session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'session_not_started');
  END IF;

  v_elapsed := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_last_seen)));
  IF v_elapsed <= 180 THEN
    v_delta := GREATEST(0, LEAST(
      p_played_seconds - v_last_played,
      v_elapsed + 2,
      EXTRACT(EPOCH FROM (v_now - v_started_at)) + 2 - v_credited,
      65
    ));
  END IF;

  UPDATE public.shadow_studio_watch_sessions
  SET last_played_seconds = GREATEST(last_played_seconds, p_played_seconds),
      credited_seconds = credited_seconds + v_delta,
      last_seen_at = v_now
  WHERE video_id = p_video_id AND viewer_id = p_viewer_id AND session_id = p_session_id;

  IF v_delta > 0 THEN
    v_day := (v_now AT TIME ZONE 'UTC')::date;
    v_month := pg_catalog.date_trunc('month', v_now AT TIME ZONE 'UTC')::date;
    INSERT INTO public.shadow_studio_video_daily_metrics
      (video_id, day_utc, watch_seconds, playback_updates)
    VALUES (p_video_id, v_day, v_delta, 1)
    ON CONFLICT (video_id, day_utc) DO UPDATE
      SET watch_seconds = public.shadow_studio_video_daily_metrics.watch_seconds + EXCLUDED.watch_seconds,
          playback_updates = public.shadow_studio_video_daily_metrics.playback_updates + 1;
    INSERT INTO public.shadow_studio_video_monthly_metrics
      (video_id, month_utc, watch_seconds, playback_updates)
    VALUES (p_video_id, v_month, v_delta, 1)
    ON CONFLICT (video_id, month_utc) DO UPDATE
      SET watch_seconds = public.shadow_studio_video_monthly_metrics.watch_seconds + EXCLUDED.watch_seconds,
          playback_updates = public.shadow_studio_video_monthly_metrics.playback_updates + 1;
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'credited_seconds', v_delta);
END;
$$;

CREATE OR REPLACE FUNCTION public.shadow_studio_record_thumbnail(
  p_video_id uuid,
  p_viewer_id uuid,
  p_surface text,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_day date := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date;
  v_month date := pg_catalog.date_trunc('month', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date;
  v_inserted integer := 0;
BEGIN
  IF p_video_id IS NULL OR p_viewer_id IS NULL
    OR p_surface IS NULL OR p_surface NOT IN ('search', 'discover', 'profile', 'author', 'related')
    OR p_action IS NULL OR p_action NOT IN ('impression', 'click') THEN
    RAISE EXCEPTION 'Invalid thumbnail event' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.fast_videos v
    WHERE v.id = p_video_id AND v.user_id <> p_viewer_id
      AND v.status = 'published' AND v.access_type = 'free'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_eligible');
  END IF;

  IF p_action = 'click' AND NOT EXISTS (
    SELECT 1 FROM public.shadow_studio_thumbnail_dedup d
    WHERE d.video_id = p_video_id AND d.viewer_id = p_viewer_id
      AND d.day_utc = v_day AND d.surface = p_surface AND d.action = 'impression'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'impression_required');
  END IF;

  INSERT INTO public.shadow_studio_thumbnail_dedup
    (video_id, viewer_id, day_utc, surface, action)
  VALUES (p_video_id, p_viewer_id, v_day, p_surface, p_action)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    INSERT INTO public.shadow_studio_video_daily_metrics
      (video_id, day_utc, thumbnail_impressions, thumbnail_clicks)
    VALUES (p_video_id, v_day,
      CASE WHEN p_action = 'impression' THEN 1 ELSE 0 END,
      CASE WHEN p_action = 'click' THEN 1 ELSE 0 END)
    ON CONFLICT (video_id, day_utc) DO UPDATE
      SET thumbnail_impressions = public.shadow_studio_video_daily_metrics.thumbnail_impressions + EXCLUDED.thumbnail_impressions,
          thumbnail_clicks = public.shadow_studio_video_daily_metrics.thumbnail_clicks + EXCLUDED.thumbnail_clicks;
    INSERT INTO public.shadow_studio_video_monthly_metrics
      (video_id, month_utc, thumbnail_impressions, thumbnail_clicks)
    VALUES (p_video_id, v_month,
      CASE WHEN p_action = 'impression' THEN 1 ELSE 0 END,
      CASE WHEN p_action = 'click' THEN 1 ELSE 0 END)
    ON CONFLICT (video_id, month_utc) DO UPDATE
      SET thumbnail_impressions = public.shadow_studio_video_monthly_metrics.thumbnail_impressions + EXCLUDED.thumbnail_impressions,
          thumbnail_clicks = public.shadow_studio_video_monthly_metrics.thumbnail_clicks + EXCLUDED.thumbnail_clicks;
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'recorded', v_inserted = 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.shadow_studio_advanced_summary(
  p_owner uuid,
  p_days integer DEFAULT 30,
  p_format text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_watch numeric := 0;
  v_impressions bigint := 0;
  v_clicks bigint := 0;
  v_updates bigint := 0;
  v_rows bigint := 0;
  v_sessions bigint := 0;
BEGIN
  IF p_owner IS NULL OR p_days NOT IN (7, 28, 30)
    OR p_format NOT IN ('all', 'videos', 'shorts') THEN
    RAISE EXCEPTION 'Invalid analytics query' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(SUM(d.watch_seconds), 0),
         COALESCE(SUM(d.thumbnail_impressions), 0),
         COALESCE(SUM(d.thumbnail_clicks), 0),
         COALESCE(SUM(d.playback_updates), 0), COUNT(d.video_id)
  INTO v_watch, v_impressions, v_clicks, v_updates, v_rows
  FROM public.shadow_studio_video_daily_metrics d
  JOIN public.fast_videos v ON v.id = d.video_id
  WHERE v.user_id = p_owner
    AND (p_format = 'all' OR v.video_type = CASE WHEN p_format = 'videos' THEN 'long' ELSE 'short' END)
    AND d.day_utc >= ((pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - (p_days - 1));

  SELECT COUNT(*) INTO v_sessions
  FROM public.shadow_studio_watch_sessions s
  JOIN public.fast_videos v ON v.id = s.video_id
  WHERE v.user_id = p_owner AND s.credited_seconds > 0
    AND (p_format = 'all' OR v.video_type = CASE WHEN p_format = 'videos' THEN 'long' ELSE 'short' END)
    AND s.last_seen_at >= pg_catalog.clock_timestamp() - (p_days || ' days')::interval;

  RETURN pg_catalog.jsonb_build_object(
    'period_days', p_days,
    'format', p_format,
    'source', 'shadow_player_estimates',
    'watch_time_hours', pg_catalog.jsonb_build_object('available', v_updates > 0, 'value', CASE WHEN v_updates > 0 THEN ROUND(v_watch / 3600, 3) ELSE NULL END),
    'average_view_seconds', pg_catalog.jsonb_build_object('available', v_sessions > 0, 'value', CASE WHEN v_sessions > 0 THEN ROUND(v_watch / v_sessions, 2) ELSE NULL END),
    'thumbnail_impressions', pg_catalog.jsonb_build_object('available', v_impressions > 0, 'value', CASE WHEN v_impressions > 0 THEN v_impressions ELSE NULL END),
    'thumbnail_clicks', pg_catalog.jsonb_build_object('available', v_impressions > 0, 'value', CASE WHEN v_impressions > 0 THEN v_clicks ELSE NULL END),
    'thumbnail_ctr_percent', pg_catalog.jsonb_build_object('available', v_impressions > 0, 'value', CASE WHEN v_impressions > 0 THEN ROUND(100.0 * v_clicks / v_impressions, 2) ELSE NULL END)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.shadow_studio_cleanup_advanced_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sessions bigint := 0;
  v_thumbnails bigint := 0;
  v_daily bigint := 0;
BEGIN
  DELETE FROM public.shadow_studio_watch_sessions
  WHERE last_seen_at < pg_catalog.clock_timestamp() - INTERVAL '35 days';
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  DELETE FROM public.shadow_studio_thumbnail_dedup
  WHERE day_utc < (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 35;
  GET DIAGNOSTICS v_thumbnails = ROW_COUNT;

  DELETE FROM public.shadow_studio_video_daily_metrics
  WHERE day_utc < (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 730;
  GET DIAGNOSTICS v_daily = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object('sessions_deleted', v_sessions, 'dedup_deleted', v_thumbnails, 'daily_deleted', v_daily);
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_studio_record_watch(uuid, uuid, uuid, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_studio_record_thumbnail(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_studio_advanced_summary(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_studio_cleanup_advanced_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_studio_record_watch(uuid, uuid, uuid, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_studio_record_thumbnail(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_studio_advanced_summary(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_studio_cleanup_advanced_metrics() TO service_role;

COMMIT;
