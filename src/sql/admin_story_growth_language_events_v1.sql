BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_story_growth_language_events (
  episode_id uuid PRIMARY KEY,
  story_id uuid NOT NULL,
  first_published_at timestamptz NOT NULL,
  first_published_day date NOT NULL,
  language_code text,
  record_source text NOT NULL DEFAULT 'live',
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_story_growth_language_code_valid
    CHECK (language_code IS NULL OR language_code IN ('km', 'en', 'zh', 'ja', 'ko')),
  CONSTRAINT admin_story_growth_record_source_valid
    CHECK (record_source IN ('live', 'backfill'))
);

CREATE INDEX IF NOT EXISTS admin_story_growth_language_day_idx
  ON public.admin_story_growth_language_events (first_published_day, language_code, story_id);

CREATE INDEX IF NOT EXISTS admin_story_growth_language_code_day_idx
  ON public.admin_story_growth_language_events (language_code, first_published_day, story_id);

ALTER TABLE public.admin_story_growth_language_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_story_growth_language_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.admin_story_growth_language_events TO service_role;

CREATE OR REPLACE FUNCTION public.admin_story_growth_language_code(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT CASE pg_catalog.split_part(
    pg_catalog.replace(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_value, ''))), '_', '-'),
    '-',
    1
  )
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
  END
$function$;

REVOKE ALL ON FUNCTION public.admin_story_growth_language_code(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_story_growth_language_code(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.capture_admin_story_growth_language_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_first_at timestamptz;
  v_language text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'published' THEN
    RETURN NEW;
  END IF;

  v_first_at := COALESCE(NEW.first_published_at, NEW.published_at);

  IF v_first_at IS NULL OR v_first_at > pg_catalog.clock_timestamp() THEN
    RETURN NEW;
  END IF;

  SELECT public.admin_story_growth_language_code(s.story_language)
    INTO v_language
  FROM public.stories s
  WHERE s.id = NEW.story_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.admin_story_growth_language_events (
    episode_id,
    story_id,
    first_published_at,
    first_published_day,
    language_code,
    record_source
  )
  VALUES (
    NEW.id,
    NEW.story_id,
    v_first_at,
    (v_first_at AT TIME ZONE 'Asia/Phnom_Penh')::date,
    v_language,
    'live'
  )
  ON CONFLICT (episode_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Story Growth language capture failed, SQLSTATE %', SQLSTATE;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_admin_story_growth_language_event()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS admin_story_growth_language_event_capture ON public.episodes;

CREATE TRIGGER admin_story_growth_language_event_capture
AFTER INSERT OR UPDATE OF status, first_published_at, published_at
ON public.episodes
FOR EACH ROW
EXECUTE FUNCTION public.capture_admin_story_growth_language_event();

CREATE OR REPLACE FUNCTION public.get_admin_story_growth_language_daily(
  p_language text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF p_language IS NULL
     OR p_language NOT IN ('km', 'en', 'zh', 'ja', 'ko') THEN
    RAISE EXCEPTION 'Unsupported Story Growth language'
      USING ERRCODE = '22023';
  END IF;

  WITH bounds AS (
    SELECT (pg_catalog.now() AT TIME ZONE 'Asia/Phnom_Penh')::date - 1 AS as_of
  ),
  days AS (
    SELECT (b.as_of - n.day_offset)::date AS day
    FROM bounds b
    CROSS JOIN pg_catalog.generate_series(0, 364) AS n(day_offset)
  ),
  aggregates AS (
    SELECT
      e.first_published_day AS day,
      COUNT(DISTINCT e.story_id) AS updated_stories,
      COUNT(*) AS new_episodes
    FROM public.admin_story_growth_language_events e
    CROSS JOIN bounds b
    WHERE e.language_code = p_language
      AND e.first_published_day BETWEEN b.as_of - 364 AND b.as_of
    GROUP BY e.first_published_day
  )
  SELECT pg_catalog.jsonb_build_object(
    'language', p_language,
    'as_of', b.as_of,
    'retention_days', 365,
    'history_quality', 'best_effort_backfill_before_install',
    'days', COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'date', d.day,
          'updated_stories', COALESCE(a.updated_stories, 0),
          'new_episodes', COALESCE(a.new_episodes, 0)
        )
        ORDER BY d.day
      ),
      '[]'::jsonb
    )
  )
  INTO v_result
  FROM bounds b
  CROSS JOIN days d
  LEFT JOIN aggregates a ON a.day = d.day
  GROUP BY b.as_of;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_admin_story_growth_language_daily(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_story_growth_language_daily(text)
  TO service_role;

COMMIT;
