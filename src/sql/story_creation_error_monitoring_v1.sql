BEGIN;

CREATE TABLE IF NOT EXISTS public.story_creation_error_events (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  story_type text NOT NULL CHECK (story_type IN ('novel', 'manga', 'chat_story')),
  stage text NOT NULL CHECK (stage IN (
    'CROP', 'LOCAL_DRAFT', 'UPLOAD_QUEUE', 'IMAGE_PROCESS',
    'ONLINE_UPLOAD', 'CREATE_STORY', 'RESTORE_DRAFT', 'UPDATE_STORY'
  )),
  error_code text NOT NULL CHECK (error_code ~ '^[A-Z0-9_]{2,64}$'),
  error_name text NOT NULL DEFAULT 'Error' CHECK (error_name ~ '^[A-Za-z0-9_-]{1,80}$'),
  browser text NOT NULL CHECK (browser IN ('CHROME', 'SAMSUNG', 'EDGE', 'FIREFOX', 'SAFARI', 'OTHER')),
  os text NOT NULL CHECK (os IN ('ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX', 'OTHER')),
  device text NOT NULL CHECK (device IN ('MOBILE', 'TABLET', 'DESKTOP')),
  bucket_start timestamptz NOT NULL,
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences BETWEEN 1 AND 1000000),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, story_type, stage, error_code, error_name, browser, os, device, bucket_start)
);

CREATE INDEX IF NOT EXISTS story_creation_errors_last_seen_idx
  ON public.story_creation_error_events (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS story_creation_errors_group_idx
  ON public.story_creation_error_events (stage, error_code, last_seen_at DESC);

ALTER TABLE public.story_creation_error_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.story_creation_error_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.story_creation_error_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_story_creation_error(
  p_user_id uuid,
  p_story_type text,
  p_stage text,
  p_error_code text,
  p_error_name text,
  p_browser text,
  p_os text,
  p_device text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_bucket timestamptz := date_trunc('hour', now()) +
    CASE WHEN extract(minute FROM now()) >= 30 THEN interval '30 minutes' ELSE interval '0 minutes' END;
BEGIN
  IF p_user_id IS NULL OR
    p_story_type IS NULL OR p_stage IS NULL OR p_error_code IS NULL OR
    p_error_name IS NULL OR p_browser IS NULL OR p_os IS NULL OR p_device IS NULL OR
    p_story_type NOT IN ('novel', 'manga', 'chat_story') OR
    p_stage NOT IN ('CROP', 'LOCAL_DRAFT', 'UPLOAD_QUEUE', 'IMAGE_PROCESS', 'ONLINE_UPLOAD', 'CREATE_STORY', 'RESTORE_DRAFT', 'UPDATE_STORY') OR
    p_error_code !~ '^[A-Z0-9_]{2,64}$' OR
    p_error_name !~ '^[A-Za-z0-9_-]{1,80}$' OR
    p_browser NOT IN ('CHROME', 'SAMSUNG', 'EDGE', 'FIREFOX', 'SAFARI', 'OTHER') OR
    p_os NOT IN ('ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX', 'OTHER') OR
    p_device NOT IN ('MOBILE', 'TABLET', 'DESKTOP') THEN
    RETURN false;
  END IF;

  INSERT INTO public.story_creation_error_events (
    user_id, story_type, stage, error_code, error_name,
    browser, os, device, bucket_start, first_seen_at, last_seen_at
  ) VALUES (
    p_user_id, p_story_type, p_stage, p_error_code, p_error_name,
    p_browser, p_os, p_device, v_bucket, v_now, v_now
  )
  ON CONFLICT (user_id, story_type, stage, error_code, error_name, browser, os, device, bucket_start)
  DO UPDATE SET
    occurrences = LEAST(1000000, public.story_creation_error_events.occurrences + 1),
    last_seen_at = excluded.last_seen_at;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_story_creation_error_diagnostics(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH selected_window AS (
    SELECT CASE WHEN p_hours IN (1, 6, 24, 168) THEN p_hours ELSE 24 END AS hours
  ),
  base AS MATERIALIZED (
    SELECT e.* FROM public.story_creation_error_events e, selected_window w
    WHERE e.last_seen_at >= now() - make_interval(hours => w.hours)
  ),
  grouped AS (
    SELECT story_type, stage, error_code, error_name,
      count(DISTINCT user_id)::integer AS user_count,
      sum(occurrences)::bigint AS event_count,
      min(first_seen_at) AS first_seen_at,
      max(last_seen_at) AS last_seen_at
    FROM base
    GROUP BY story_type, stage, error_code, error_name
    ORDER BY count(DISTINCT user_id) DESC, sum(occurrences) DESC
    LIMIT 50
  )
  SELECT jsonb_build_object(
    'available', true,
    'generated_at', now(),
    'hours', (SELECT hours FROM selected_window),
    'total_events', COALESCE((SELECT sum(occurrences) FROM base), 0),
    'affected_users', COALESCE((SELECT count(DISTINCT user_id) FROM base), 0),
    'groups', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'story_type', g.story_type,
        'stage', g.stage,
        'error_code', g.error_code,
        'error_name', g.error_name,
        'user_count', g.user_count,
        'event_count', g.event_count,
        'first_seen_at', g.first_seen_at,
        'last_seen_at', g.last_seen_at,
        'affected_devices', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'os', d.os,
            'browser', d.browser,
            'device', d.device,
            'user_count', d.user_count,
            'event_count', d.event_count
          ) ORDER BY d.user_count DESC, d.event_count DESC)
          FROM (
            SELECT b.os, b.browser, b.device,
              count(DISTINCT b.user_id) AS user_count,
              sum(b.occurrences) AS event_count
            FROM base b
            WHERE b.story_type = g.story_type AND b.stage = g.stage
              AND b.error_code = g.error_code AND b.error_name = g.error_name
            GROUP BY b.os, b.browser, b.device
          ) d
        ), '[]'::jsonb),
        'users', CASE WHEN g.user_count <= 10 THEN COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'user_id', person.user_id,
            'username', person.username,
            'name', person.name
          ) ORDER BY person.username, person.user_id)
          FROM (
            SELECT DISTINCT b.user_id, COALESCE(u.username, '') AS username,
              COALESCE(u.name, '') AS name
            FROM base b
            LEFT JOIN public.users u ON u.id = b.user_id
            WHERE b.story_type = g.story_type AND b.stage = g.stage
              AND b.error_code = g.error_code AND b.error_name = g.error_name
          ) person
        ), '[]'::jsonb) ELSE '[]'::jsonb END
      ) ORDER BY g.user_count DESC, g.event_count DESC)
      FROM grouped g
    ), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.prune_story_creation_error_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.story_creation_error_events
  WHERE last_seen_at < now() - interval '14 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.record_story_creation_error(uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_story_creation_error_diagnostics(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_story_creation_error_events() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_story_creation_error(uuid, text, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_story_creation_error_diagnostics(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_story_creation_error_events() TO service_role;

COMMIT;
