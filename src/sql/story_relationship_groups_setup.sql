CREATE OR REPLACE FUNCTION public.shadow_normalize_relationship_tag(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(lower(coalesce(value, '')), '[''’‘`]', '', 'g'),
    '[^a-z0-9]+', ' ', 'g'
  ));
$$;

CREATE OR REPLACE FUNCTION public.shadow_story_relationship_groups(p_main_genre text, p_tags jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH raw_values AS (
    SELECT p_main_genre AS value
    UNION ALL
    SELECT CASE
      WHEN jsonb_typeof(item) = 'string' THEN item #>> '{}'
      WHEN jsonb_typeof(item) = 'object' THEN coalesce(
        item ->> 'name', item ->> 'label', item ->> 'slug',
        item ->> 'value', item ->> 'tag', ''
      )
      ELSE ''
    END
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_tags) = 'array' THEN p_tags ELSE '[]'::jsonb END
    ) AS entries(item)
  ),
  normalized AS (
    SELECT public.shadow_normalize_relationship_tag(piece) AS token
    FROM raw_values
    CROSS JOIN LATERAL regexp_split_to_table(coalesce(value, ''), '[,;|]') AS piece
  ),
  matched AS (
    SELECT
      coalesce(bool_or(token = ANY (ARRAY[
        'bl', 'boys love', 'boy love', 'boyslove', 'boylove', 'yaoi',
        'danmei', 'shounen ai', 'shonen ai', 'male male',
        'male male romance', 'm m', 'm x m', 'mlm', 'achillean',
        'gay romance', 'gay love'
      ])), false) AS is_bl,
      coalesce(bool_or(token = ANY (ARRAY[
        'gl', 'girls love', 'girl love', 'girlslove', 'girllove', 'yuri',
        'baihe', 'shoujo ai', 'shojo ai', 'female female',
        'female female romance', 'f f', 'f x f', 'wlw', 'sapphic',
        'lesbian', 'lesbian romance', 'lesbian love'
      ])), false) AS is_gl,
      coalesce(bool_or(token = ANY (ARRAY[
        'lgbtq', 'lgbtq plus', 'lgbt', 'lgbtqia', 'queer',
        'queer romance', 'gay', 'bisexual', 'pansexual', 'asexual',
        'transgender', 'nonbinary', 'non binary', 'genderqueer'
      ])), false) AS is_lgbtq
    FROM normalized
  )
  SELECT CASE
    WHEN is_bl OR is_gl OR is_lgbtq THEN array_remove(
      ARRAY[
        CASE WHEN is_bl THEN 'BL' END,
        CASE WHEN is_gl THEN 'GL' END,
        'LGBTQ+'
      ]::text[], null
    )
    ELSE ARRAY['BG']::text[]
  END
  FROM matched;
$$;

ALTER TABLE public.stories
ADD COLUMN IF NOT EXISTS relationship_groups text[] DEFAULT ARRAY['BG']::text[];

CREATE OR REPLACE FUNCTION public.shadow_sync_story_relationship_groups()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.relationship_groups := public.shadow_story_relationship_groups(
    NEW.main_genre, to_jsonb(NEW.tags)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shadow_sync_story_relationship_groups ON public.stories;

CREATE TRIGGER shadow_sync_story_relationship_groups
BEFORE INSERT OR UPDATE OF main_genre, tags
ON public.stories
FOR EACH ROW
EXECUTE FUNCTION public.shadow_sync_story_relationship_groups();

UPDATE public.stories
SET relationship_groups = public.shadow_story_relationship_groups(main_genre, to_jsonb(tags))
WHERE relationship_groups IS DISTINCT FROM
      public.shadow_story_relationship_groups(main_genre, to_jsonb(tags));

CREATE INDEX IF NOT EXISTS stories_relationship_groups_published_idx
ON public.stories USING gin (relationship_groups)
WHERE status = 'published' AND deleted_at IS NULL;
