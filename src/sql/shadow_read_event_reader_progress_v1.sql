BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_reader_progress(
  p_event_id uuid,
  p_user_id uuid
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
  v_joined boolean := false;
  v_daily_points bigint := 0;
  v_overall_points bigint := 0;
  v_missions jsonb := '[]'::jsonb;
  v_milestones jsonb := '[]'::jsonb;
BEGIN
  IF p_event_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Read Event progress input' USING ERRCODE = '22023';
  END IF;

  SELECT w.starts_on, w.is_enabled, w.audience_group
    INTO v_start, v_enabled, v_audience
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id;

  IF NOT FOUND OR v_enabled IS DISTINCT FROM true OR v_audience IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Read Event is not available' USING ERRCODE = '22023';
  END IF;

  v_day := v_today - v_start + 1;
  IF v_day NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'Read Event is outside its active week' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.users AS u
    LEFT JOIN public.shadow_reader_classifications AS c ON c.user_id = u.id
    LEFT JOIN public.shadow_reader_language_snapshots AS s ON s.user_id = u.id
    WHERE u.id = p_user_id
      AND (
        c.admin_group_override = 'kh'
        OR (
          c.admin_group_override IS NULL
          AND COALESCE(s.khmer_stories, 0) + COALESCE(s.international_stories, 0) >= 3
          AND COALESCE(s.khmer_stories, 0) >= COALESCE(s.international_stories, 0)
        )
      )
  ) THEN
    RAISE EXCEPTION 'Reader is not eligible for Read Event' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.shadow_read_event_participants AS p
    WHERE p.event_id = p_event_id
      AND p.user_id = p_user_id
      AND p.reader_group_snapshot = 'kh'
  ) INTO v_joined;

  IF v_joined THEN
    SELECT COALESCE(SUM(e.points), 0),
           COALESCE(SUM(e.points) FILTER (WHERE e.day_number = v_day), 0)
      INTO v_overall_points, v_daily_points
    FROM public.shadow_read_event_score_events AS e
    WHERE e.event_id = p_event_id
      AND e.user_id = p_user_id;
  END IF;

  WITH earned AS (
    SELECT e.mission_id, SUM(e.points) AS points
    FROM public.shadow_read_event_score_events AS e
    WHERE v_joined
      AND e.event_id = p_event_id
      AND e.user_id = p_user_id
      AND e.day_number = v_day
      AND e.score_source = 'mission'
    GROUP BY e.mission_id
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'mission_id', m.id,
        'slot', m.slot,
        'mission_type', m.mission_type,
        'target_amount', m.target_amount,
        'max_points', m.max_points,
        'earned_points', LEAST(m.max_points::bigint, COALESCE(e.points, 0)),
        'completed', COALESCE(e.points, 0) >= m.max_points
      ) ORDER BY m.slot
    ),
    '[]'::jsonb
  ) INTO v_missions
  FROM public.shadow_read_event_missions AS m
  LEFT JOIN earned AS e ON e.mission_id = m.id
  WHERE m.event_id = p_event_id
    AND m.day_number = v_day;

  WITH claims AS (
    SELECT c.tier,
           BOOL_OR(c.grant_status = 'granted') AS granted,
           BOOL_OR(c.grant_status = 'pending') AS pending
    FROM public.shadow_read_event_reward_claims AS c
    WHERE v_joined
      AND c.event_id = p_event_id
      AND c.user_id = p_user_id
      AND c.reward_type = 'milestone'
      AND c.day_number = v_day
    GROUP BY c.tier
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'tier', m.tier,
        'required_points', m.required_points,
        'coin_reward', m.coin_reward,
        'unlocked', v_joined AND v_daily_points >= m.required_points,
        'granted', COALESCE(c.granted, false),
        'status', CASE
          WHEN COALESCE(c.granted, false) THEN 'granted'
          WHEN COALESCE(c.pending, false) THEN 'pending'
          WHEN v_joined AND v_daily_points >= m.required_points THEN 'unlocked'
          ELSE 'locked'
        END
      ) ORDER BY m.tier
    ),
    '[]'::jsonb
  ) INTO v_milestones
  FROM public.shadow_read_event_milestones AS m
  LEFT JOIN claims AS c ON c.tier = m.tier
  WHERE m.event_id = p_event_id
    AND m.day_number = v_day;

  IF pg_catalog.jsonb_array_length(v_missions) <> 5
     OR pg_catalog.jsonb_array_length(v_milestones) <> 5
  THEN
    RAISE EXCEPTION 'Read Event daily configuration is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'day_number', v_day,
    'joined', v_joined,
    'daily_points', v_daily_points,
    'overall_points', v_overall_points,
    'missions', v_missions,
    'milestones', v_milestones
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_reader_progress(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_reader_progress(uuid, uuid)
  TO service_role;

COMMIT;
