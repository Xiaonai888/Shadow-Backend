BEGIN;

CREATE TABLE IF NOT EXISTS public.shadow_reader_language_snapshots (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  khmer_stories bigint NOT NULL DEFAULT 0 CHECK (khmer_stories >= 0),
  international_stories bigint NOT NULL DEFAULT 0 CHECK (international_stories >= 0),
  khmer_episodes bigint NOT NULL DEFAULT 0 CHECK (khmer_episodes >= 0),
  international_episodes bigint NOT NULL DEFAULT 0 CHECK (international_episodes >= 0),
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.shadow_reader_language_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shadow_reader_language_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_reader_language_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_admin_reader_classification_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_saved bigint := 0;
  v_removed bigint := 0;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(712553821) THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'skipped', true);
  END IF;

  WITH viewed AS MATERIALIZED (
    SELECT user_id, story_id, episode_id
    FROM public.reading_progress
    WHERE user_id IS NOT NULL AND story_id IS NOT NULL
    UNION
    SELECT user_id, story_id, episode_id
    FROM public.episode_view_logs
    WHERE user_id IS NOT NULL AND story_id IS NOT NULL
  ), evidence AS (
    SELECT
      v.user_id,
      COUNT(DISTINCT v.story_id) FILTER (
        WHERE pg_catalog.lower(pg_catalog.btrim(COALESCE(s.story_language, '')))
          IN ('km', 'kh', 'khmer', 'ខ្មែរ')
      ) AS khmer_stories,
      COUNT(DISTINCT v.story_id) FILTER (
        WHERE pg_catalog.btrim(COALESCE(s.story_language, '')) <> ''
          AND pg_catalog.lower(pg_catalog.btrim(s.story_language))
            NOT IN ('km', 'kh', 'khmer', 'ខ្មែរ')
      ) AS international_stories,
      COUNT(DISTINCT v.episode_id) FILTER (
        WHERE pg_catalog.lower(pg_catalog.btrim(COALESCE(s.story_language, '')))
          IN ('km', 'kh', 'khmer', 'ខ្មែរ')
      ) AS khmer_episodes,
      COUNT(DISTINCT v.episode_id) FILTER (
        WHERE pg_catalog.btrim(COALESCE(s.story_language, '')) <> ''
          AND pg_catalog.lower(pg_catalog.btrim(s.story_language))
            NOT IN ('km', 'kh', 'khmer', 'ខ្មែរ')
      ) AS international_episodes
    FROM viewed v
    JOIN public.stories s ON s.id = v.story_id
    GROUP BY v.user_id
  ), written AS (
    INSERT INTO public.shadow_reader_language_snapshots (
      user_id, khmer_stories, international_stories,
      khmer_episodes, international_episodes, refreshed_at
    )
    SELECT
      user_id, khmer_stories, international_stories,
      khmer_episodes, international_episodes, v_now
    FROM evidence
    ON CONFLICT (user_id) DO UPDATE SET
      khmer_stories = EXCLUDED.khmer_stories,
      international_stories = EXCLUDED.international_stories,
      khmer_episodes = EXCLUDED.khmer_episodes,
      international_episodes = EXCLUDED.international_episodes,
      refreshed_at = EXCLUDED.refreshed_at
    RETURNING user_id
  )
  SELECT COUNT(*) INTO v_saved FROM written;

  DELETE FROM public.shadow_reader_language_snapshots
  WHERE refreshed_at < v_now;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'users_updated', v_saved,
    'stale_rows_removed', v_removed,
    'refreshed_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_admin_reader_classification_snapshot()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_admin_reader_classification_snapshot()
TO service_role;

CREATE OR REPLACE FUNCTION public.get_admin_reader_classification_analytics(
  p_search text DEFAULT '',
  p_group text DEFAULT 'all',
  p_limit integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_search text := pg_catalog.left(pg_catalog.btrim(COALESCE(p_search, '')), 90);
  v_group text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_group, 'all')));
  v_limit integer := pg_catalog.least(pg_catalog.greatest(COALESCE(p_limit, 10), 1), 10);
  v_result jsonb;
BEGIN
  IF v_group NOT IN ('all', 'kh', 'international', 'unknown') THEN
    RAISE EXCEPTION 'Invalid reader classification group';
  END IF;

  WITH classified AS MATERIALIZED (
    SELECT
      u.id,
      COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), 'Reader') AS name,
      COALESCE(u.username, '') AS username,
      u.created_at AS joined_at,
      rc.detected_country,
      rc.admin_country_override,
      rc.admin_group_override,
      COALESCE(s.khmer_stories, 0) AS khmer_stories,
      COALESCE(s.international_stories, 0) AS international_stories,
      COALESCE(s.khmer_episodes, 0) AS khmer_episodes,
      COALESCE(s.international_episodes, 0) AS international_episodes,
      s.refreshed_at AS reading_snapshot_refreshed_at,
      CASE
        WHEN rc.admin_group_override IN ('kh', 'international') THEN rc.admin_group_override
        WHEN COALESCE(s.khmer_stories, 0) + COALESCE(s.international_stories, 0) < 3
          THEN 'unknown'
        WHEN COALESCE(s.khmer_stories, 0) >= COALESCE(s.international_stories, 0)
          THEN 'kh'
        ELSE 'international'
      END AS reader_group
    FROM public.users u
    LEFT JOIN public.shadow_reader_classifications rc ON rc.user_id = u.id
    LEFT JOIN public.shadow_reader_language_snapshots s ON s.user_id = u.id
  ), totals AS (
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE reader_group = 'kh') AS kh,
      COUNT(*) FILTER (WHERE reader_group = 'international') AS international,
      COUNT(*) FILTER (WHERE reader_group = 'unknown') AS unknown,
      COALESCE(SUM(khmer_episodes), 0) AS khmer_episodes,
      COALESCE(SUM(international_episodes), 0) AS international_episodes,
      MIN(reading_snapshot_refreshed_at) AS snapshot_refreshed_at,
      COUNT(reading_snapshot_refreshed_at) AS snapshot_readers
    FROM classified
  ), filtered AS (
    SELECT * FROM classified
    WHERE (v_group = 'all' OR reader_group = v_group)
      AND (
        v_search = '' OR id::text = v_search
        OR name ILIKE '%' || pg_catalog.replace(pg_catalog.replace(v_search, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
        OR username ILIKE '%' || pg_catalog.replace(pg_catalog.replace(v_search, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      )
    ORDER BY joined_at DESC NULLS LAST, id DESC
    LIMIT v_limit + 1
  ), numbered AS (
    SELECT f.*, pg_catalog.row_number() OVER (ORDER BY joined_at DESC NULLS LAST, id DESC) AS rn
    FROM filtered f
  ), page_data AS (
    SELECT
      COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', id,
          'name', name,
          'username', username,
          'joined_at', joined_at,
          'detected_country', detected_country,
          'effective_country', COALESCE(admin_country_override, detected_country),
          'admin_country_override', admin_country_override,
          'admin_group_override', admin_group_override,
          'reader_group', reader_group,
          'classification_source', CASE
            WHEN admin_country_override IS NOT NULL OR admin_group_override IS NOT NULL THEN 'admin_override'
            WHEN reader_group <> 'unknown' THEN 'story_language'
            WHEN detected_country IS NOT NULL THEN 'ip_country'
            ELSE 'unknown'
          END,
          'khmer_stories', khmer_stories,
          'international_stories', international_stories,
          'khmer_episodes', khmer_episodes,
          'total_episodes', khmer_episodes + international_episodes,
          'khmer_read_percent', CASE
            WHEN khmer_episodes + international_episodes > 0 THEN
              pg_catalog.round(100.0 * khmer_episodes / (khmer_episodes + international_episodes), 2)
            ELSE NULL
          END
        ) ORDER BY joined_at DESC NULLS LAST, id DESC
      ) FILTER (WHERE rn <= v_limit), '[]'::jsonb) AS items,
      COUNT(*) > v_limit AS has_next
    FROM numbered
  )
  SELECT pg_catalog.jsonb_build_object(
    'ok', true,
    'items', page_data.items,
    'has_next', page_data.has_next,
    'page', 1,
    'limit', v_limit,
    'summary', pg_catalog.jsonb_build_object(
      'total', totals.total,
      'kh', totals.kh,
      'international', totals.international,
      'unknown', totals.unknown,
      'khmer_episodes', totals.khmer_episodes,
      'international_episodes', totals.international_episodes,
      'snapshot_refreshed_at', totals.snapshot_refreshed_at,
      'snapshot_readers', totals.snapshot_readers
    )
  ) INTO v_result
  FROM totals CROSS JOIN page_data;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_reader_classification_analytics(text, text, integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_reader_classification_analytics(text, text, integer)
TO service_role;

COMMIT;

SELECT public.refresh_admin_reader_classification_snapshot();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.schedule(
        'shadow_reader_language_snapshot_6h',
        '17 */6 * * *',
        'SELECT public.refresh_admin_reader_classification_snapshot()'
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not schedule refresh. Run refresh_admin_reader_classification_snapshot() separately.';
    END;
  ELSE
    RAISE NOTICE 'pg_cron unavailable: run refresh_admin_reader_classification_snapshot() periodically.';
  END IF;
END;
$$;
