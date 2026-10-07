SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('get_public_story_updates', 'get_public_weekly_story_updates')
ORDER BY p.proname, arguments;

SELECT *
FROM public.get_public_story_updates(
  p_language => NULL::text,
  p_story_type => NULL::text,
  p_include_adult => false,
  p_days => 7,
  p_limit_per_day => 5,
  p_story_setting => NULL::text
);

SELECT *
FROM public.get_public_weekly_story_updates(
  p_language => NULL::text,
  p_story_type => NULL::text,
  p_include_adult => false,
  p_limit => 5,
  p_story_setting => NULL::text
);
