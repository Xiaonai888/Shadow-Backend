BEGIN;

CREATE TABLE IF NOT EXISTS public.shadow_reader_classifications (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  detected_country text,
  detected_source text,
  admin_country_override text,
  admin_group_override text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_reader_classification_detected_country_check
    CHECK (detected_country IS NULL OR (detected_country ~ '^[A-Z]{2}$' AND detected_country NOT IN ('XX', 'ZZ', 'T1'))),
  CONSTRAINT shadow_reader_classification_admin_country_check
    CHECK (admin_country_override IS NULL OR (admin_country_override ~ '^[A-Z]{2}$' AND admin_country_override NOT IN ('XX', 'ZZ', 'T1'))),
  CONSTRAINT shadow_reader_classification_admin_group_check
    CHECK (admin_group_override IS NULL OR admin_group_override IN ('kh', 'international'))
);

CREATE INDEX IF NOT EXISTS shadow_reader_classifications_country_idx
  ON public.shadow_reader_classifications (detected_country);

CREATE INDEX IF NOT EXISTS shadow_reader_classifications_override_idx
  ON public.shadow_reader_classifications (admin_country_override)
  WHERE admin_country_override IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.shadow_reader_classification_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  previous_country text,
  new_country text,
  previous_group text,
  new_group text,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shadow_reader_classification_history_user_time_idx
  ON public.shadow_reader_classification_history (user_id, changed_at DESC, id DESC);

ALTER TABLE public.shadow_reader_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_reader_classification_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.shadow_reader_classifications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.shadow_reader_classification_history FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_reader_classifications TO service_role;
GRANT SELECT, INSERT ON public.shadow_reader_classification_history TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.shadow_reader_classification_history_id_seq TO service_role;

INSERT INTO public.shadow_reader_classifications (
  user_id,
  detected_country,
  detected_source
)
SELECT
  u.id,
  CASE
    WHEN UPPER(TRIM(COALESCE(NULLIF(TRIM(rp.last_country_code), ''), NULLIF(TRIM(rp.first_country_code), ''), ''))) ~ '^[A-Z]{2}$'
      AND UPPER(TRIM(COALESCE(NULLIF(TRIM(rp.last_country_code), ''), NULLIF(TRIM(rp.first_country_code), ''), ''))) NOT IN ('XX', 'ZZ', 'T1')
    THEN UPPER(TRIM(COALESCE(NULLIF(TRIM(rp.last_country_code), ''), NULLIF(TRIM(rp.first_country_code), ''), '')))
    ELSE NULL
  END,
  CASE
    WHEN UPPER(TRIM(COALESCE(NULLIF(TRIM(rp.last_country_code), ''), NULLIF(TRIM(rp.first_country_code), ''), ''))) ~ '^[A-Z]{2}$'
      AND UPPER(TRIM(COALESCE(NULLIF(TRIM(rp.last_country_code), ''), NULLIF(TRIM(rp.first_country_code), ''), ''))) NOT IN ('XX', 'ZZ', 'T1')
    THEN 'admin_reader_presence'
    ELSE NULL
  END
FROM public.users u
LEFT JOIN public.reader_presence rp ON rp.user_id = u.id
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.save_shadow_reader_country_once(
  p_user_id uuid,
  p_country_code text,
  p_source text DEFAULT 'admin_reader_presence'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_country text := UPPER(TRIM(COALESCE(p_country_code, '')));
  v_saved text;
BEGIN
  IF v_country !~ '^[A-Z]{2}$' OR v_country IN ('XX', 'ZZ', 'T1') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.shadow_reader_classifications (
    user_id, detected_country, detected_source
  ) VALUES (
    p_user_id, v_country, LEFT(NULLIF(TRIM(p_source), ''), 64)
  )
  ON CONFLICT (user_id) DO UPDATE SET
    detected_country = EXCLUDED.detected_country,
    detected_source = EXCLUDED.detected_source,
    updated_at = now()
  WHERE public.shadow_reader_classifications.detected_country IS NULL;

  SELECT detected_country INTO v_saved
  FROM public.shadow_reader_classifications
  WHERE user_id = p_user_id;

  RETURN v_saved;
END;
$$;

REVOKE ALL ON FUNCTION public.save_shadow_reader_country_once(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_shadow_reader_country_once(uuid, text, text)
  TO service_role;

COMMIT;
