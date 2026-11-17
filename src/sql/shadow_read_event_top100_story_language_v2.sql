BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_daily_leaderboard(
  p_event_id uuid, p_day_number integer, p_viewer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_starts_on date;
  v_enabled boolean;
  v_audience text;
  v_top_100 jsonb := '[]'::jsonb;
  v_top_three jsonb := '[]'::jsonb;
  v_scored_readers bigint := 0;
  v_viewer_rank bigint;
  v_viewer_points bigint := 0;
  v_last_score_at timestamptz;
  v_day_date date;
BEGIN
  IF p_event_id IS NULL OR p_day_number IS NULL OR p_day_number NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'Invalid Read Event leaderboard request' USING ERRCODE = '22023';
  END IF;

  SELECT w.starts_on, w.is_enabled, w.audience_group
    INTO v_starts_on, v_enabled, v_audience
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id;

  IF NOT FOUND OR v_enabled IS DISTINCT FROM true OR v_audience IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Read Event leaderboard is not available' USING ERRCODE = '22023';
  END IF;

  v_day_date := v_starts_on + (p_day_number - 1);
  IF v_day_date > v_today THEN
    RAISE EXCEPTION 'Future Read Event leaderboard cannot be viewed' USING ERRCODE = '22023';
  END IF;

  WITH score_totals AS MATERIALIZED (
    SELECT e.user_id,
           pg_catalog.sum(e.points)::bigint AS points,
           pg_catalog.max(e.created_at) AS last_score_at
    FROM public.shadow_read_event_score_events AS e
    JOIN public.shadow_read_event_participants AS p
      ON p.event_id = e.event_id AND p.user_id = e.user_id
    JOIN public.users AS u ON u.id = e.user_id
    WHERE e.event_id = p_event_id
      AND e.day_number = p_day_number
      AND p.reader_group_snapshot = 'kh'
      AND u.is_active IS DISTINCT FROM false
    GROUP BY e.user_id
    HAVING pg_catalog.sum(e.points) > 0
  ),
  ranked AS MATERIALIZED (
    SELECT t.user_id, t.points, t.last_score_at,
           pg_catalog.row_number() OVER (
             ORDER BY t.points DESC, t.last_score_at ASC, t.user_id ASC
           ) AS rank_number
    FROM score_totals AS t
  ),
  visible AS MATERIALIZED (
    SELECT r.user_id, r.rank_number, r.points, r.last_score_at,
           COALESCE(
             NULLIF(pg_catalog.btrim(u.name), ''),
             NULLIF(pg_catalog.btrim(u.username), ''),
             'Reader'
           ) AS reader_name,
           u.username, u.avatar_url
    FROM ranked AS r
    JOIN public.users AS u ON u.id = r.user_id
    WHERE r.rank_number <= 100
  )
  SELECT
    COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rank', r.rank_number,
          'user_id', r.user_id,
          'name', r.reader_name,
          'username', r.username,
          'avatar_url', r.avatar_url,
          'points', r.points,
          'last_score_at', r.last_score_at,
          'prize_preview', CASE WHEN r.rank_number <= 3 THEN
            pg_catalog.jsonb_build_object(
              'coins', CASE r.rank_number WHEN 1 THEN 1000 WHEN 2 THEN 700 WHEN 3 THEN 500 ELSE 0 END,
              'vouchers', CASE r.rank_number WHEN 1 THEN 10 WHEN 2 THEN 7 WHEN 3 THEN 5 ELSE 0 END
            )
          ELSE NULL END
        ) ORDER BY r.rank_number
      ) FROM visible AS r
    ), '[]'::jsonb),
    (SELECT pg_catalog.count(*) FROM ranked),
    (SELECT r.rank_number FROM ranked AS r WHERE r.user_id = p_viewer_id),
    COALESCE((SELECT r.points FROM ranked AS r WHERE r.user_id = p_viewer_id), 0),
    (SELECT pg_catalog.max(r.last_score_at) FROM ranked AS r)
  INTO v_top_100, v_scored_readers, v_viewer_rank, v_viewer_points, v_last_score_at;

  SELECT COALESCE(pg_catalog.jsonb_agg(x.item ORDER BY (x.item ->> 'rank')::integer), '[]'::jsonb)
    INTO v_top_three
  FROM pg_catalog.jsonb_array_elements(v_top_100) AS x(item)
  WHERE (x.item ->> 'rank')::integer BETWEEN 1 AND 3;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'day_number', p_day_number,
    'day_date', v_day_date,
    'day_closed', v_day_date < v_today,
    'scored_readers', v_scored_readers,
    'top_three', v_top_three,
    'top_100', v_top_100,
    'my_rank', v_viewer_rank,
    'my_points', v_viewer_points,
    'last_score_at', v_last_score_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_daily_leaderboard(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_daily_leaderboard(uuid, integer, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.shadow_read_event_overall_leaderboard(
  p_event_id uuid, p_viewer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_starts_on date;
  v_enabled boolean;
  v_audience text;
  v_top_100 jsonb := '[]'::jsonb;
  v_top_three jsonb := '[]'::jsonb;
  v_scored_readers bigint := 0;
  v_viewer_rank bigint;
  v_viewer_points bigint := 0;
  v_last_score_at timestamptz;
  v_ends_on date;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Read Event leaderboard request' USING ERRCODE = '22023';
  END IF;

  SELECT w.starts_on, w.is_enabled, w.audience_group
    INTO v_starts_on, v_enabled, v_audience
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id;

  IF NOT FOUND OR v_enabled IS DISTINCT FROM true OR v_audience IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Read Event leaderboard is not available' USING ERRCODE = '22023';
  END IF;

  IF v_starts_on > v_today THEN
    RAISE EXCEPTION 'Future Read Event leaderboard cannot be viewed' USING ERRCODE = '22023';
  END IF;
  v_ends_on := v_starts_on + 6;

  WITH score_totals AS MATERIALIZED (
    SELECT e.user_id,
           pg_catalog.sum(e.points)::bigint AS points,
           pg_catalog.max(e.created_at) AS last_score_at
    FROM public.shadow_read_event_score_events AS e
    JOIN public.shadow_read_event_participants AS p
      ON p.event_id = e.event_id AND p.user_id = e.user_id
    JOIN public.users AS u ON u.id = e.user_id
    WHERE e.event_id = p_event_id
      AND e.day_number BETWEEN 1 AND 7
      AND p.reader_group_snapshot = 'kh'
      AND u.is_active IS DISTINCT FROM false
    GROUP BY e.user_id
    HAVING pg_catalog.sum(e.points) > 0
  ),
  ranked AS MATERIALIZED (
    SELECT t.user_id, t.points, t.last_score_at,
           pg_catalog.row_number() OVER (
             ORDER BY t.points DESC, t.last_score_at ASC, t.user_id ASC
           ) AS rank_number
    FROM score_totals AS t
  ),
  visible AS MATERIALIZED (
    SELECT r.user_id, r.rank_number, r.points, r.last_score_at,
           COALESCE(
             NULLIF(pg_catalog.btrim(u.name), ''),
             NULLIF(pg_catalog.btrim(u.username), ''),
             'Reader'
           ) AS reader_name,
           u.username, u.avatar_url
    FROM ranked AS r
    JOIN public.users AS u ON u.id = r.user_id
    WHERE r.rank_number <= 100
  )
  SELECT
    COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rank', r.rank_number,
          'user_id', r.user_id,
          'name', r.reader_name,
          'username', r.username,
          'avatar_url', r.avatar_url,
          'points', r.points,
          'last_score_at', r.last_score_at,
          'prize_preview', CASE WHEN r.rank_number <= 3 THEN
            pg_catalog.jsonb_build_object(
              'story_cards', CASE r.rank_number WHEN 1 THEN 100 WHEN 2 THEN 70 WHEN 3 THEN 50 ELSE 0 END,
              'gift_box', pg_catalog.jsonb_build_object(
                'coins_min', 1000, 'coins_max', 10000,
                'vouchers_min', 10, 'vouchers_max', 100
              )
            )
          ELSE NULL END
        ) ORDER BY r.rank_number
      ) FROM visible AS r
    ), '[]'::jsonb),
    (SELECT pg_catalog.count(*) FROM ranked),
    (SELECT r.rank_number FROM ranked AS r WHERE r.user_id = p_viewer_id),
    COALESCE((SELECT r.points FROM ranked AS r WHERE r.user_id = p_viewer_id), 0),
    (SELECT pg_catalog.max(r.last_score_at) FROM ranked AS r)
  INTO v_top_100, v_scored_readers, v_viewer_rank, v_viewer_points, v_last_score_at;

  SELECT COALESCE(pg_catalog.jsonb_agg(x.item ORDER BY (x.item ->> 'rank')::integer), '[]'::jsonb)
    INTO v_top_three
  FROM pg_catalog.jsonb_array_elements(v_top_100) AS x(item)
  WHERE (x.item ->> 'rank')::integer BETWEEN 1 AND 3;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'starts_on', v_starts_on,
    'ends_on', v_ends_on,
    'is_final', v_today > v_ends_on,
    'scored_readers', v_scored_readers,
    'top_three', v_top_three,
    'top_100', v_top_100,
    'my_rank', v_viewer_rank,
    'my_points', v_viewer_points,
    'last_score_at', v_last_score_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_overall_leaderboard(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_overall_leaderboard(uuid, uuid) TO service_role;

DO $patch$
DECLARE
  v_signature text;
  v_definition text;
  v_rewritten text;
  v_pattern text := '(?s)AND \(\s*c\.admin_group_override = ''kh''\s*OR\s*\(\s*c\.admin_group_override IS NULL\s*AND COALESCE\(s\.khmer_stories, 0\) \+ COALESCE\(s\.international_stories, 0\) >= 3\s*AND COALESCE\(s\.khmer_stories, 0\) >= COALESCE\(s\.international_stories, 0\)\s*\)\s*\)';
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.shadow_read_event_settle_daily_top3(uuid,integer)',
    'public.shadow_read_event_settle_overall_top3(uuid)'
  ] LOOP
    IF pg_catalog.to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'Required Read Event settlement function is missing: %', v_signature;
    END IF;

    SELECT pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature))
      INTO v_definition;

    IF pg_catalog.strpos(v_definition, 'c.admin_group_override') = 0 THEN
      IF pg_catalog.strpos(v_definition, 'p.reader_group_snapshot') = 0 THEN
        RAISE EXCEPTION 'Cannot verify Read Event settlement eligibility: %', v_signature;
      END IF;
      CONTINUE;
    END IF;

    v_rewritten := pg_catalog.regexp_replace(v_definition, v_pattern, '', 'g');
    IF v_rewritten = v_definition OR pg_catalog.strpos(v_rewritten, 'c.admin_group_override') > 0 THEN
      RAISE EXCEPTION 'Unexpected Read Event settlement definition; nothing changed: %', v_signature;
    END IF;

    EXECUTE v_rewritten;
  END LOOP;
END;
$patch$;

COMMIT;
