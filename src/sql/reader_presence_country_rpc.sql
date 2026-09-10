CREATE OR REPLACE FUNCTION public.touch_reader_presence_with_country(
  p_user_id uuid,
  p_session_id text,
  p_current_path text,
  p_visibility_state text,
  p_is_active boolean,
  p_user_agent text,
  p_country_code text,
  p_country_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := NOW();
  v_code text := UPPER(NULLIF(TRIM(p_country_code), ''));
  v_name text := NULLIF(TRIM(p_country_name), '');
BEGIN
  PERFORM public.touch_reader_presence(
    p_user_id,
    p_session_id,
    p_current_path,
    p_visibility_state,
    p_is_active,
    p_user_agent
  );

  IF v_code IS NULL OR v_code IN ('XX', 'T1') THEN
    RETURN;
  END IF;

  UPDATE public.reader_presence
  SET
    first_country_code = COALESCE(NULLIF(first_country_code, ''), v_code),
    first_country_name = CASE
      WHEN NULLIF(first_country_code, '') IS NULL THEN COALESCE(v_name, v_code)
      ELSE first_country_name
    END,
    last_country_code = v_code,
    last_country_name = COALESCE(v_name, v_code),
    country_first_seen_at = COALESCE(country_first_seen_at, v_now),
    country_last_seen_at = v_now
  WHERE user_id = p_user_id
    AND (
      NULLIF(first_country_code, '') IS NULL
      OR NULLIF(last_country_code, '') IS DISTINCT FROM v_code
      OR NULLIF(last_country_name, '') IS NULL
      OR country_last_seen_at IS NULL
      OR country_last_seen_at < v_now - INTERVAL '12 hours'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.touch_reader_presence_with_country(
  uuid,
  text,
  text,
  text,
  boolean,
  text,
  text,
  text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.touch_reader_presence_with_country(
  uuid,
  text,
  text,
  text,
  boolean,
  text,
  text,
  text
) TO service_role;
