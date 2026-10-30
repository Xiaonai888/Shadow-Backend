BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_overall_leaderboard(
  p_event_id uuid,
  p_viewer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_starts_on date;
  v_ends_on date;
  v_enabled boolean;
  v_audience text;
  v_top_three jsonb := '[]'::jsonb;
  v_scored_readers bigint := 0;
  v_viewer_rank bigint;
  v_viewer_points bigint := 0;
  v_last_score_at timestamptz;
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
    LEFT JOIN public.shadow_reader_classifications AS c
      ON c.user_id = e.user_id
    LEFT JOIN public.shadow_reader_language_snapshots AS s
      ON s.user_id = e.user_id
    WHERE e.event_id = p_event_id
      AND e.day_number BETWEEN 1 AND 7
      AND p.reader_group_snapshot = 'kh'
      AND u.is_active IS DISTINCT FROM false
      AND (
        c.admin_group_override = 'kh'
        OR (
          c.admin_group_override IS NULL
          AND COALESCE(s.khmer_stories, 0) + COALESCE(s.international_stories, 0) >= 3
          AND COALESCE(s.khmer_stories, 0) >= COALESCE(s.international_stories, 0)
        )
      )
    GROUP BY e.user_id
    HAVING pg_catalog.sum(e.points) > 0
  ),
  ranked AS MATERIALIZED (
    SELECT t.user_id, t.points, t.last_score_at,
           pg_catalog.row_number() OVER (
             ORDER BY t.points DESC, t.last_score_at ASC, t.user_id ASC
           ) AS rank_number
    FROM score_totals AS t
  )
  SELECT
    COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rank', r.rank_number,
          'user_id', r.user_id,
          'name', COALESCE(
            NULLIF(pg_catalog.btrim(u.name), ''),
            NULLIF(pg_catalog.btrim(u.username), ''),
            'Reader'
          ),
          'username', u.username,
          'avatar_url', u.avatar_url,
          'points', r.points,
          'last_score_at', r.last_score_at,
          'prize_preview', pg_catalog.jsonb_build_object(
            'story_cards', CASE r.rank_number
              WHEN 1 THEN 100 WHEN 2 THEN 70 WHEN 3 THEN 50 ELSE 0 END,
            'gift_box', pg_catalog.jsonb_build_object(
              'coins_min', 1000, 'coins_max', 10000,
              'vouchers_min', 10, 'vouchers_max', 100
            )
          )
        ) ORDER BY r.rank_number
      )
      FROM ranked AS r
      JOIN public.users AS u ON u.id = r.user_id
      WHERE r.rank_number <= 3
    ), '[]'::jsonb),
    (SELECT pg_catalog.count(*) FROM ranked),
    (SELECT r.rank_number FROM ranked AS r WHERE r.user_id = p_viewer_id),
    COALESCE((SELECT r.points FROM ranked AS r WHERE r.user_id = p_viewer_id), 0),
    (SELECT pg_catalog.max(r.last_score_at) FROM ranked AS r)
  INTO v_top_three, v_scored_readers, v_viewer_rank, v_viewer_points, v_last_score_at;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'starts_on', v_starts_on,
    'ends_on', v_ends_on,
    'is_final', v_today > v_ends_on,
    'scored_readers', v_scored_readers,
    'top_three', v_top_three,
    'my_rank', v_viewer_rank,
    'my_points', v_viewer_points,
    'last_score_at', v_last_score_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_overall_leaderboard(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_overall_leaderboard(uuid, uuid)
  TO service_role;

COMMIT;
