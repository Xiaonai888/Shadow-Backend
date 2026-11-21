CREATE INDEX IF NOT EXISTS episodes_admin_story_update_first_published_idx
ON public.episodes (first_published_at DESC, story_id)
WHERE status = 'published'
  AND deleted_at IS NULL
  AND first_published_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_admin_story_update_activity_v2(
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_sort text DEFAULT 'episodes',
  p_page integer DEFAULT 1,
  p_limit integer DEFAULT 10,
  p_search text DEFAULT '',
  p_story_type text DEFAULT 'all',
  p_language text DEFAULT 'all',
  p_genre text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_result jsonb;
  v_page integer := LEAST(GREATEST(COALESCE(p_page, 1), 1), 100000);
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100);
  v_search text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_search, '')));
  v_story_type text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_story_type, 'all')));
  v_genre text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_genre, 'all')));
BEGIN
  IF p_start_at IS NULL OR p_end_at IS NULL
     OR p_start_at >= p_end_at
     OR p_end_at - p_start_at > INTERVAL '32 days'
     OR p_sort IS NULL OR p_sort NOT IN ('episodes', 'consistency', 'latest')
     OR p_language IS NULL OR p_language NOT IN ('all', 'km', 'en', 'zh', 'ja', 'ko')
     OR pg_catalog.char_length(v_search) > 120
     OR pg_catalog.char_length(v_story_type) > 60
     OR pg_catalog.char_length(v_genre) > 100 THEN
    RAISE EXCEPTION 'Invalid Story Updates request'
      USING ERRCODE = '22023';
  END IF;

  WITH episode_base AS MATERIALIZED (
    SELECT
      e.id AS episode_id,
      e.title AS episode_title,
      e.episode_number,
      e.first_published_at AS published_at,
      s.id AS story_id,
      s.author_id,
      s.title AS story_title,
      s.cover_url,
      COALESCE(s.story_type, 'novel') AS story_type,
      s.story_language,
      s.main_genre,
      COALESCE(s.admin_visibility_status, 'active') AS admin_visibility_status,
      public.admin_story_growth_language_code(s.story_language) AS language_code,
      a.page_name,
      a.page_username
    FROM public.episodes e
    JOIN public.stories s ON s.id = e.story_id
    JOIN public.author_pages a ON a.id = s.author_id
    WHERE e.status = 'published'
      AND e.deleted_at IS NULL
      AND e.first_published_at >= p_start_at
      AND e.first_published_at < p_end_at
      AND s.deleted_at IS NULL
  ),
  filter_options AS (
    SELECT pg_catalog.jsonb_build_object(
      'story_types', COALESCE((
        SELECT pg_catalog.jsonb_agg(x.story_type ORDER BY x.story_type)
        FROM (
          SELECT DISTINCT story_type
          FROM episode_base
          WHERE story_type IS NOT NULL
          ORDER BY story_type
          LIMIT 100
        ) x
      ), '[]'::jsonb),
      'languages', COALESCE((
        SELECT pg_catalog.jsonb_agg(x.story_language ORDER BY x.story_language)
        FROM (
          SELECT DISTINCT story_language
          FROM episode_base
          WHERE story_language IS NOT NULL AND story_language <> ''
          ORDER BY story_language
          LIMIT 100
        ) x
      ), '[]'::jsonb),
      'genres', COALESCE((
        SELECT pg_catalog.jsonb_agg(x.main_genre ORDER BY x.main_genre)
        FROM (
          SELECT DISTINCT main_genre
          FROM episode_base
          WHERE main_genre IS NOT NULL AND main_genre <> ''
          ORDER BY main_genre
          LIMIT 100
        ) x
      ), '[]'::jsonb)
    ) AS value
  ),
  filtered AS MATERIALIZED (
    SELECT *
    FROM episode_base e
    WHERE (v_story_type = 'all' OR pg_catalog.lower(e.story_type) = v_story_type)
      AND (p_language = 'all' OR e.language_code = p_language)
      AND (v_genre = 'all' OR pg_catalog.lower(COALESCE(e.main_genre, '')) = v_genre)
      AND (
        v_search = ''
        OR pg_catalog.strpos(
          pg_catalog.lower(pg_catalog.concat_ws(
            ' ', e.page_name, e.page_username, e.story_title,
            e.story_id::text, e.episode_title
          )),
          v_search
        ) > 0
      )
  ),
  author_totals AS (
    SELECT
      author_id,
      COUNT(DISTINCT story_id) AS stories_updated,
      COUNT(*) AS new_episodes,
      COUNT(DISTINCT (published_at AT TIME ZONE 'Asia/Phnom_Penh')::date) AS active_days,
      MAX(published_at) AS last_update
    FROM filtered
    GROUP BY author_id
  ),
  summary_counts AS (
    SELECT
      (SELECT COUNT(*) FROM author_totals) AS total_authors,
      (SELECT COUNT(DISTINCT story_id) FROM filtered) AS updated_stories,
      (SELECT COUNT(*) FROM filtered) AS new_episodes
  ),
  pages AS (
    SELECT
      GREATEST(
        1,
        pg_catalog.ceil(total_authors::numeric / v_limit)::integer
      ) AS total_pages,
      total_authors,
      updated_stories,
      new_episodes
    FROM summary_counts
  ),
  pagination AS (
    SELECT
      LEAST(v_page, total_pages) AS safe_page,
      total_pages,
      total_authors,
      updated_stories,
      new_episodes
    FROM pages
  ),
  ranked_authors AS (
    SELECT
      a.*,
      ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN p_sort = 'consistency' THEN a.active_days END DESC NULLS LAST,
          CASE WHEN p_sort = 'latest' THEN a.last_update END DESC NULLS LAST,
          a.new_episodes DESC,
          a.active_days DESC,
          a.last_update DESC,
          a.author_id
      ) AS author_rank
    FROM author_totals a
  ),
  page_authors AS (
    SELECT r.*
    FROM ranked_authors r
    CROSS JOIN pagination p
    WHERE r.author_rank > (p.safe_page - 1) * v_limit
      AND r.author_rank <= p.safe_page * v_limit
  ),
  page_story_totals AS (
    SELECT
      f.author_id,
      f.story_id,
      COUNT(*) AS new_episodes,
      MAX(f.published_at) AS last_update
    FROM filtered f
    JOIN page_authors p ON p.author_id = f.author_id
    GROUP BY f.author_id, f.story_id
  ),
  page_story_latest AS (
    SELECT DISTINCT ON (f.author_id, f.story_id)
      f.author_id,
      f.story_id,
      f.episode_id,
      f.episode_title,
      f.episode_number,
      f.published_at
    FROM filtered f
    JOIN page_authors p ON p.author_id = f.author_id
    ORDER BY f.author_id, f.story_id, f.published_at DESC,
             f.episode_number DESC NULLS LAST, f.episode_id DESC
  ),
  story_details AS (
    SELECT
      t.author_id,
      t.story_id,
      t.last_update,
      pg_catalog.jsonb_build_object(
        'id', s.id,
        'title', s.title,
        'cover_url', s.cover_url,
        'story_type', COALESCE(s.story_type, 'novel'),
        'story_language', COALESCE(s.story_language, ''),
        'main_genre', COALESCE(s.main_genre, ''),
        'admin_visibility_status', COALESCE(s.admin_visibility_status, 'active'),
        'new_episodes', t.new_episodes,
        'last_update', t.last_update,
        'latest_episode', pg_catalog.jsonb_build_object(
          'id', latest.episode_id,
          'title', latest.episode_title,
          'episode_number', latest.episode_number,
          'first_published_at', latest.published_at
        )
      ) AS story
    FROM page_story_totals t
    JOIN public.stories s ON s.id = t.story_id
    JOIN page_story_latest latest
      ON latest.author_id = t.author_id AND latest.story_id = t.story_id
  ),
  ranked_stories AS (
    SELECT
      d.*,
      ROW_NUMBER() OVER (
        PARTITION BY d.author_id
        ORDER BY d.last_update DESC, d.story_id
      ) AS story_rank
    FROM story_details d
  ),
  stories_by_author AS (
    SELECT
      author_id,
      pg_catalog.jsonb_agg(story ORDER BY last_update DESC, story_id) AS stories
    FROM ranked_stories
    WHERE story_rank <= 100
    GROUP BY author_id
  ),
  page_output AS (
    SELECT
      COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rank', p.author_rank,
          'author', pg_catalog.jsonb_build_object(
            'id', a.id,
            'user_id', a.user_id,
            'page_name', a.page_name,
            'page_username', a.page_username,
            'page_slug', a.page_slug,
            'avatar_url', a.avatar_url,
            'status', a.status,
            'admin_status', COALESCE(a.admin_status, 'active'),
            'admin_disabled_reason', COALESCE(a.admin_disabled_reason, ''),
            'admin_disabled_at', a.admin_disabled_at,
            'policy_warning_count', COALESCE(a.policy_warning_count, 0),
            'total_stories', COALESCE(a.total_stories, 0),
            'total_followers', COALESCE(a.total_followers, 0),
            'created_at', a.created_at,
            'updated_at', a.updated_at
          ),
          'stories_updated', p.stories_updated,
          'new_episodes', p.new_episodes,
          'active_days', p.active_days,
          'last_update', p.last_update,
          'stories', COALESCE(sa.stories, '[]'::jsonb),
          'stories_truncated', p.stories_updated > 100
        )
        ORDER BY p.author_rank
      ), '[]'::jsonb) AS authors
    FROM page_authors p
    JOIN public.author_pages a ON a.id = p.author_id
    LEFT JOIN stories_by_author sa ON sa.author_id = p.author_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'summary', pg_catalog.jsonb_build_object(
      'active_authors', p.total_authors,
      'updated_stories', p.updated_stories,
      'new_episodes', p.new_episodes,
      'top_author', (
        SELECT pg_catalog.jsonb_build_object(
          'author', pg_catalog.jsonb_build_object(
            'id', a.id,
            'page_name', a.page_name,
            'page_username', a.page_username,
            'avatar_url', a.avatar_url
          ),
          'new_episodes', t.new_episodes,
          'active_days', t.active_days
        )
        FROM author_totals t
        JOIN public.author_pages a ON a.id = t.author_id
        ORDER BY t.new_episodes DESC, t.active_days DESC,
                 t.last_update DESC, t.author_id
        LIMIT 1
      )
    ),
    'authors', po.authors,
    'filter_options', fo.value,
    'page', p.safe_page,
    'limit', v_limit,
    'total', p.total_authors,
    'total_pages', p.total_pages,
    'has_next', p.safe_page < p.total_pages,
    'has_prev', p.safe_page > 1
  )
  INTO v_result
  FROM pagination p
  CROSS JOIN filter_options fo
  CROSS JOIN page_output po;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_admin_story_update_activity_v2(
  timestamptz, timestamptz, text, integer, integer, text, text, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_admin_story_update_activity_v2(
  timestamptz, timestamptz, text, integer, integer, text, text, text, text
) TO service_role;
