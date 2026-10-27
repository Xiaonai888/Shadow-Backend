-- NEW: Shadow-Backend/src/sql/admin_reader_classification_smart_search_v1.sql
-- Run once in Supabase SQL Editor. Alters only the Reader Classification search RPC.
-- Keeps analytics summary, country/group classification and 10-result response contract.
BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

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
  v_search text := pg_catalog.lower(pg_catalog.left(pg_catalog.btrim(COALESCE(p_search, '')), 90));
  v_term text := pg_catalog.ltrim(v_search, '@');
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
      -- Optional field: safely NULL if users has no nickname column.
      NULLIF(pg_catalog.btrim(COALESCE(pg_catalog.to_jsonb(u)->>'nickname', '')), '') AS nickname,
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
        WHEN COALESCE(s.khmer_stories, 0) + COALESCE(s.international_stories, 0) < 3 THEN 'unknown'
        WHEN COALESCE(s.khmer_stories, 0) >= COALESCE(s.international_stories, 0) THEN 'kh'
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
  ), scored AS (
    SELECT c.*,
      CASE
        WHEN v_search = '' THEN 0
        WHEN v_term = '' THEN 0
        WHEN c.id::text = v_term THEN 1200
        WHEN pg_catalog.lower(c.username) = v_term THEN 1150
        WHEN pg_catalog.lower(c.name) = v_term THEN 1100
        WHEN pg_catalog.lower(COALESCE(c.nickname, '')) = v_term THEN 1050
        WHEN pg_catalog.length(v_term) >= 4
          AND pg_catalog.left(c.id::text, pg_catalog.length(v_term)) = v_term THEN 1000
        WHEN pg_catalog.left(pg_catalog.lower(c.username), pg_catalog.length(v_term)) = v_term THEN 950
        WHEN pg_catalog.left(pg_catalog.lower(c.name), pg_catalog.length(v_term)) = v_term THEN 900
        WHEN c.nickname IS NOT NULL
          AND pg_catalog.left(pg_catalog.lower(c.nickname), pg_catalog.length(v_term)) = v_term THEN 870
        WHEN pg_catalog.length(v_term) >= 4
          AND pg_catalog.strpos(c.id::text, v_term) > 0 THEN 850
        WHEN pg_catalog.strpos(pg_catalog.lower(c.username), v_term) > 0 THEN 800
        WHEN pg_catalog.strpos(pg_catalog.lower(c.name), v_term) > 0 THEN 750
        WHEN c.nickname IS NOT NULL
          AND pg_catalog.strpos(pg_catalog.lower(c.nickname), v_term) > 0 THEN 720
        WHEN pg_catalog.length(v_term) >= 3 AND pg_catalog.greatest(
          extensions.similarity(pg_catalog.lower(c.name), v_term),
          extensions.similarity(pg_catalog.lower(c.username), v_term),
          extensions.similarity(pg_catalog.lower(COALESCE(c.nickname, '')), v_term)
        ) >= 0.48 THEN 250 + pg_catalog.round(400 * pg_catalog.greatest(
          extensions.similarity(pg_catalog.lower(c.name), v_term),
          extensions.similarity(pg_catalog.lower(c.username), v_term),
          extensions.similarity(pg_catalog.lower(COALESCE(c.nickname, '')), v_term)
        ))::integer
        ELSE 0
      END AS search_score
    FROM classified c
    WHERE v_group = 'all' OR c.reader_group = v_group
  ), filtered AS (
    SELECT * FROM scored
    WHERE v_search = '' OR search_score > 0
    ORDER BY search_score DESC, joined_at DESC NULLS LAST, id DESC
    LIMIT v_limit + 1
  ), numbered AS (
    SELECT f.*,
      pg_catalog.row_number() OVER (ORDER BY search_score DESC, joined_at DESC NULLS LAST, id DESC) AS rn
    FROM filtered f
  ), page_data AS (
    SELECT
      COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', id,
          'name', name,
          'username', username,
          'nickname', nickname,
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
        ) ORDER BY search_score DESC, joined_at DESC NULLS LAST, id DESC
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
