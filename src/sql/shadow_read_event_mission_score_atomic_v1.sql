BEGIN;

CREATE INDEX IF NOT EXISTS shadow_read_event_score_mission_total_idx
ON public.shadow_read_event_score_events (event_id, user_id, mission_id)
INCLUDE (points)
WHERE score_source = 'mission';

CREATE OR REPLACE FUNCTION public.shadow_read_event_record_mission_points(
  p_event_id uuid,
  p_user_id uuid,
  p_mission_id uuid,
  p_evidence_key text,
  p_points integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_start date;
  v_enabled boolean;
  v_audience text;
  v_day integer;
  v_max_points integer;
  v_mission_type text;
  v_slot integer;
  v_evidence text := pg_catalog.btrim(COALESCE(p_evidence_key, ''));
  v_source_key text;
  v_group_override text;
  v_khmer_stories integer := 0;
  v_international_stories integer := 0;
  v_earned integer := 0;
  v_credited integer := 0;
  v_daily_total integer := 0;
  v_existing_id uuid;
  v_inserted_id uuid;
BEGIN
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_mission_id IS NULL
     OR p_points IS NULL OR p_points NOT BETWEEN 1 AND 100000
     OR v_evidence !~ '^[A-Za-z0-9:_-]{1,100}$'
  THEN
    RAISE EXCEPTION 'Invalid Read Event score input' USING ERRCODE = '22023';
  END IF;

  v_source_key := 'mission:' || p_mission_id::text || ':' || v_evidence;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'shadow_read_event_score:' || p_event_id::text || ':' || p_user_id::text,
      0
    )
  );

  SELECT w.starts_on, w.is_enabled, w.audience_group
  INTO v_start, v_enabled, v_audience
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id
  FOR SHARE;

  IF NOT FOUND OR v_enabled IS DISTINCT FROM true OR v_audience IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Read Event is not enabled' USING ERRCODE = '22023';
  END IF;

  v_day := v_today - v_start + 1;
  IF v_day NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'Read Event is outside its scoring window' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.shadow_read_event_participants AS p
    WHERE p.event_id = p_event_id
      AND p.user_id = p_user_id
      AND p.reader_group_snapshot = 'kh'
      AND p.joined_at <= pg_catalog.clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Reader has not joined this Read Event' USING ERRCODE = '22023';
  END IF;

  SELECT c.admin_group_override,
         COALESCE(s.khmer_stories, 0),
         COALESCE(s.international_stories, 0)
  INTO v_group_override, v_khmer_stories, v_international_stories
  FROM public.users AS u
  LEFT JOIN public.shadow_reader_classifications AS c ON c.user_id = u.id
  LEFT JOIN public.shadow_reader_language_snapshots AS s ON s.user_id = u.id
  WHERE u.id = p_user_id;

  IF NOT (
    v_group_override = 'kh'
    OR (
      v_group_override IS NULL
      AND v_khmer_stories + v_international_stories >= 3
      AND v_khmer_stories >= v_international_stories
    )
  ) THEN
    RAISE EXCEPTION 'Only Khmer Reader is eligible' USING ERRCODE = '22023';
  END IF;

  SELECT m.max_points, m.mission_type, m.slot
  INTO v_max_points, v_mission_type, v_slot
  FROM public.shadow_read_event_missions AS m
  WHERE m.id = p_mission_id
    AND m.event_id = p_event_id
    AND m.day_number = v_day
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission does not belong to the current event day' USING ERRCODE = '22023';
  END IF;

  SELECT e.id INTO v_existing_id
  FROM public.shadow_read_event_score_events AS e
  WHERE e.event_id = p_event_id
    AND e.user_id = p_user_id
    AND e.source_key = v_source_key;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'awarded', false,
      'reason', 'duplicate_evidence',
      'event_id', p_event_id,
      'day_number', v_day,
      'mission_id', p_mission_id,
      'points_added', 0
    );
  END IF;

  SELECT COALESCE(pg_catalog.sum(e.points), 0)::integer
  INTO v_earned
  FROM public.shadow_read_event_score_events AS e
  WHERE e.event_id = p_event_id
    AND e.user_id = p_user_id
    AND e.mission_id = p_mission_id
    AND e.score_source = 'mission';

  IF v_earned >= v_max_points THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'awarded', false,
      'reason', 'mission_points_complete',
      'event_id', p_event_id,
      'day_number', v_day,
      'mission_id', p_mission_id,
      'points_added', 0,
      'mission_points', v_earned
    );
  END IF;

  v_credited := LEAST(p_points, v_max_points - v_earned);

  INSERT INTO public.shadow_read_event_score_events (
    event_id, user_id, day_number, mission_id,
    score_source, source_key, points
  ) VALUES (
    p_event_id, p_user_id, v_day, p_mission_id,
    'mission', v_source_key, v_credited
  )
  ON CONFLICT (event_id, user_id, source_key) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'awarded', false,
      'reason', 'duplicate_evidence',
      'event_id', p_event_id,
      'day_number', v_day,
      'mission_id', p_mission_id,
      'points_added', 0
    );
  END IF;

  SELECT COALESCE(pg_catalog.sum(e.points), 0)::integer
  INTO v_daily_total
  FROM public.shadow_read_event_score_events AS e
  WHERE e.event_id = p_event_id
    AND e.user_id = p_user_id
    AND e.day_number = v_day;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'awarded', true,
    'event_id', p_event_id,
    'day_number', v_day,
    'mission_id', p_mission_id,
    'mission_type', v_mission_type,
    'slot', v_slot,
    'points_added', v_credited,
    'mission_points', v_earned + v_credited,
    'mission_max_points', v_max_points,
    'daily_points', v_daily_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_record_mission_points(
  uuid, uuid, uuid, text, integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.shadow_read_event_record_mission_points(
  uuid, uuid, uuid, text, integer
) TO service_role;

COMMIT;
