CREATE OR REPLACE FUNCTION public.bump_shadow_public_story_versions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.content_versions AS cv (
    content_key,
    version,
    updated_at
  )
  VALUES
    ('stories', 2, NOW()),
    ('home', 2, NOW())
  ON CONFLICT (content_key)
  DO UPDATE SET
    version = COALESCE(cv.version, 1) + 1,
    updated_at = EXCLUDED.updated_at;

  RETURN NULL;
END;
$$;

INSERT INTO public.content_versions (
  content_key,
  version,
  updated_at
)
VALUES
  ('stories', 1, NOW()),
  ('home', 1, NOW())
ON CONFLICT (content_key) DO NOTHING;

DROP TRIGGER IF EXISTS shadow_story_version_insert_delete
ON public.stories;

CREATE TRIGGER shadow_story_version_insert_delete
AFTER INSERT OR DELETE
ON public.stories
FOR EACH STATEMENT
EXECUTE FUNCTION public.bump_shadow_public_story_versions();

DROP TRIGGER IF EXISTS shadow_story_version_update
ON public.stories;

CREATE TRIGGER shadow_story_version_update
AFTER UPDATE OF
  author_id,
  title,
  story_type,
  story_language,
  main_genre,
  story_status,
  tags,
  description,
  is_adult,
  cover_url,
  landscape_thumbnail_url,
  status,
  access_type,
  is_shadow_exclusive,
  exclusive_status,
  exclusive_sections,
  update_days,
  deleted_at
ON public.stories
FOR EACH STATEMENT
EXECUTE FUNCTION public.bump_shadow_public_story_versions();

DROP TRIGGER IF EXISTS shadow_episode_version_insert_delete
ON public.episodes;

CREATE TRIGGER shadow_episode_version_insert_delete
AFTER INSERT OR DELETE
ON public.episodes
FOR EACH STATEMENT
EXECUTE FUNCTION public.bump_shadow_public_story_versions();

DROP TRIGGER IF EXISTS shadow_episode_version_update
ON public.episodes;

CREATE TRIGGER shadow_episode_version_update
AFTER UPDATE OF
  title,
  cover_url,
  is_adult,
  is_free_published,
  unlock_methods,
  status,
  episode_number,
  published_at,
  deleted_at
ON public.episodes
FOR EACH STATEMENT
EXECUTE FUNCTION public.bump_shadow_public_story_versions();
