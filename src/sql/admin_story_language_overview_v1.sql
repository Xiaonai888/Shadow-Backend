CREATE OR REPLACE FUNCTION public.get_admin_story_language_overview(p_language text DEFAULT 'all')
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
WITH selected_stories AS (
  SELECT
    s.deleted_at,
    s.admin_visibility_status,
    s.policy_warning_count,
    s.story_status,
    s.total_episodes,
    CASE split_part(replace(lower(btrim(coalesce(s.story_language, ''))), '_', '-'), '-', 1)
      WHEN 'khmer' THEN 'km'
      WHEN 'cambodian' THEN 'km'
      WHEN 'kh' THEN 'km'
      WHEN 'km' THEN 'km'
      WHEN 'english' THEN 'en'
      WHEN 'en' THEN 'en'
      WHEN 'chinese' THEN 'zh'
      WHEN 'mandarin' THEN 'zh'
      WHEN 'cn' THEN 'zh'
      WHEN 'zh' THEN 'zh'
      WHEN 'japanese' THEN 'ja'
      WHEN 'jp' THEN 'ja'
      WHEN 'ja' THEN 'ja'
      WHEN 'korean' THEN 'ko'
      WHEN 'kr' THEN 'ko'
      WHEN 'ko' THEN 'ko'
      ELSE NULL
    END AS normalized_language
  FROM public.stories s
), filtered_stories AS (
  SELECT *
  FROM selected_stories
  WHERE p_language = 'all' OR normalized_language = p_language
)
SELECT jsonb_build_object(
  'total_stories', COUNT(*),
  'active_stories', COUNT(*) FILTER (WHERE deleted_at IS NULL),
  'deleted_by_authors', COUNT(*) FILTER (WHERE deleted_at IS NOT NULL),
  'restricted_stories', COUNT(*) FILTER (
  WHERE deleted_at IS NULL
    AND admin_visibility_status = 'restricted'
),
'disabled_stories', COUNT(*) FILTER (
  WHERE deleted_at IS NULL
    AND admin_visibility_status = 'disabled'
),
  'warned_stories', COUNT(*) FILTER (WHERE coalesce(policy_warning_count, 0) > 0),
  'disabled_authors', (SELECT COUNT(*) FROM public.author_pages WHERE admin_status = 'disabled'),
  'new_stories', COUNT(*) FILTER (
    WHERE deleted_at IS NULL
      AND coalesce(total_episodes, 0) = 1
      AND lower(coalesce(story_status, '')) <> 'completed'
  ),
  'ongoing_stories', COUNT(*) FILTER (
    WHERE deleted_at IS NULL
      AND coalesce(total_episodes, 0) >= 2
      AND lower(coalesce(story_status, '')) <> 'completed'
  ),
  'completed_stories', COUNT(*) FILTER (
    WHERE deleted_at IS NULL
      AND lower(coalesce(story_status, '')) = 'completed'
  )
)
FROM filtered_stories
$function$;

REVOKE ALL ON FUNCTION public.get_admin_story_language_overview(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_story_language_overview(text) FROM anon;
REVOKE ALL ON FUNCTION public.get_admin_story_language_overview(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_story_language_overview(text) TO service_role;
