BEGIN;

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
  v_search text := LEFT(TRIM(COALESCE(p_search, '')), 90);
  v_group text := LOWER(TRIM(COALESCE(p_group, 'all')));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 10);
  v_result jsonb;
BEGIN
  IF v_group NOT IN ('all', 'kh', 'international', 'unknown') THEN
    RAISE EXCEPTION 'Invalid reader classification group';
  END IF;

  WITH reading_evidence AS MATERIALIZED (
    SELECT
      progress.user_id,
      COUNT(DISTINCT progress.story_id) FILTER (
        WHERE LOWER(TRIM(story.story_language)) IN ('km', 'kh', 'khmer', 'ខ្មែរ')
      ) AS khmer_stories,
      COUNT(DISTINCT progress.story_id) FILTER (
        WHERE TRIM(COALESCE(story.story_language, '')) <> ''
          AND LOWER(TRIM(story.story_language)) NOT IN ('km', 'kh', 'khmer', 'ខ្មែរ')
      ) AS international_stories,
      COUNT(DISTINCT progress.episode_id) FILTER (
        WHERE LOWER(TRIM(story.story_language)) IN ('km', 'kh', 'khmer', 'ខ្មែរ')
      ) AS khmer_episodes,
      COUNT(DISTINCT progress.episode_id) FILTER (
        WHERE TRIM(COALESCE(story.story_language, '')) <> ''
          AND LOWER(TRIM(story.story_language)) NOT IN ('km', 'kh', 'khmer', 'ខ្មែរ')
      ) AS international_episodes
    FROM public.reading_progress AS progress
    JOIN public.stories AS story ON story.id = progress.story_id
    GROUP BY progress.user_id
  ), classified AS MATERIALIZED (
    SELECT
      usr.id,
      COALESCE(NULLIF(usr.name, ''), NULLIF(usr.username, ''), 'Reader') AS name,
      COALESCE(usr.username, '') AS username,
      usr.created_at AS joined_at,
      CASE
        WHEN UPPER(TRIM(COALESCE(record.detected_country, ''))) ~ '^[A-Z]{2}$'
          AND UPPER(TRIM(record.detected_country)) NOT IN ('XX', 'ZZ', 'T1')
        THEN UPPER(TRIM(record.detected_country))
        ELSE NULL
      END AS detected_country,
      CASE
        WHEN UPPER(TRIM(COALESCE(record.admin_country_override, ''))) ~ '^[A-Z]{2}$'
          AND UPPER(TRIM(record.admin_country_override)) NOT IN ('XX', 'ZZ', 'T1')
        THEN UPPER(TRIM(record.admin_country_override))
        ELSE NULL
      END AS admin_country_override,
      record.admin_group_override,
      COALESCE(evidence.khmer_stories, 0) AS khmer_stories,
      COALESCE(evidence.international_stories, 0) AS international_stories,
      COALESCE(evidence.khmer_episodes, 0) AS khmer_episodes,
      COALESCE(evidence.international_episodes, 0) AS international_episodes,
      CASE
        WHEN record.admin_group_override IN ('kh', 'international')
          THEN record.admin_group_override
        WHEN COALESCE(evidence.khmer_stories, 0)
          + COALESCE(evidence.international_stories, 0) < 3 THEN 'unknown'
        WHEN COALESCE(evidence.khmer_stories, 0) >= COALESCE(evidence.international_stories, 0)
          THEN 'kh'
        ELSE 'international'
      END AS reader_group
    FROM public.users AS usr
    LEFT JOIN public.shadow_reader_classifications AS record ON record.user_id = usr.id
    LEFT JOIN reading_evidence AS evidence ON evidence.user_id = usr.id
  ), totals AS (
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE reader_group = 'kh') AS kh,
      COUNT(*) FILTER (WHERE reader_group = 'international') AS international,
      COUNT(*) FILTER (WHERE reader_group = 'unknown') AS unknown,
      COALESCE(SUM(khmer_episodes), 0) AS khmer_episodes,
      COALESCE(SUM(international_episodes), 0) AS international_episodes
    FROM classified
  ), selected AS (
    SELECT *
    FROM classified
    WHERE (v_group = 'all' OR reader_group = v_group)
      AND (
        v_search = ''
        OR id::text = v_search
        OR name ILIKE '%' || v_search || '%'
        OR username ILIKE '%' || v_search || '%'
      )
    ORDER BY joined_at DESC NULLS LAST, id DESC
    LIMIT v_limit + 1
  ), numbered AS (
    SELECT selected.*, ROW_NUMBER() OVER (ORDER BY joined_at DESC NULLS LAST, id DESC) AS row_number
    FROM selected
  ), page_data AS (
    SELECT
      COALESCE(
        JSONB_AGG(
          JSONB_BUILD_OBJECT(
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
              WHEN admin_group_override IS NOT NULL OR admin_country_override IS NOT NULL
                THEN 'admin_override'
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
                ROUND(100.0 * khmer_episodes / (khmer_episodes + international_episodes), 2)
              ELSE NULL
            END
          ) ORDER BY joined_at DESC NULLS LAST, id DESC
        ) FILTER (WHERE row_number <= v_limit),
        '[]'::jsonb
      ) AS items,
      COUNT(*) > v_limit AS has_next
    FROM numbered
  )
  SELECT JSONB_BUILD_OBJECT(
    'ok', TRUE,
    'items', page_data.items,
    'has_next', page_data.has_next,
    'page', 1,
    'limit', v_limit,
    'summary', JSONB_BUILD_OBJECT(
      'total', totals.total,
      'kh', totals.kh,
      'international', totals.international,
      'unknown', totals.unknown,
      'khmer_episodes', totals.khmer_episodes,
      'international_episodes', totals.international_episodes
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
