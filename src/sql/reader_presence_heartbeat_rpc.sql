CREATE OR REPLACE FUNCTION public.upsert_reader_presence_heartbeat(
  p_user_id uuid,
  p_session_id text,
  p_current_path text,
  p_visibility_state text,
  p_is_active boolean,
  p_user_agent text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := NOW();
BEGIN
  INSERT INTO public.reader_presence (
    user_id,
    session_id,
    session_started_at,
    last_seen_at,
    last_activity_at,
    current_path,
    visibility_state,
    user_agent,
    updated_at
  )
  VALUES (
    p_user_id,
    p_session_id,
    v_now,
    v_now,
    v_now,
    p_current_path,
    p_visibility_state,
    p_user_agent,
    v_now
  )
  ON CONFLICT (user_id)
  DO UPDATE SET
    session_id = EXCLUDED.session_id,
    session_started_at =
      CASE
        WHEN public.reader_presence.session_id
          IS DISTINCT FROM EXCLUDED.session_id
          OR public.reader_presence.last_seen_at IS NULL
          OR public.reader_presence.last_seen_at
            < v_now - INTERVAL '10 minutes'
        THEN v_now
        ELSE public.reader_presence.session_started_at
      END,
    last_seen_at = v_now,
    last_activity_at =
      CASE
        WHEN p_is_active
        THEN v_now
        ELSE COALESCE(
          public.reader_presence.last_activity_at,
          v_now
        )
      END,
    current_path = EXCLUDED.current_path,
    visibility_state = EXCLUDED.visibility_state,
    user_agent = EXCLUDED.user_agent,
    updated_at = v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_reader_presence_heartbeat(
  uuid,
  text,
  text,
  text,
  boolean,
  text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.upsert_reader_presence_heartbeat(
  uuid,
  text,
  text,
  text,
  boolean,
  text
) TO service_role;
