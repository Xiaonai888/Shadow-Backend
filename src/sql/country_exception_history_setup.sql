-- SHADOW / Country Settings > User Exceptions / durable audit history
-- NEW file: Shadow-Backend/src/sql/country_exception_history_setup.sql
-- Run ONCE (safe to rerun) in Supabase SQL Editor before deploying the RPC-backed routes.
-- This is separate from admin_activity_logs, which currently has a 90-day cleanup.
BEGIN;

-- Deliberately NO foreign key to users/exceptions: history survives revocation
-- and even deletion of the linked user or exception record.
CREATE TABLE IF NOT EXISTS public.shadow_country_exception_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id uuid NOT NULL,
  user_id uuid NOT NULL,
  user_name text NOT NULL DEFAULT '',
  action text NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'REVOKE')),
  actor_admin_id text,
  actor_name text NOT NULL DEFAULT 'Unattributed',
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_country_exception_history_states_check CHECK (
    (before_state IS NULL OR jsonb_typeof(before_state) = 'object') AND
    (after_state IS NULL OR jsonb_typeof(after_state) = 'object') AND
    (
      (action = 'CREATE' AND before_state IS NULL AND after_state IS NOT NULL) OR
      (action = 'UPDATE' AND before_state IS NOT NULL AND after_state IS NOT NULL) OR
      (action = 'REVOKE' AND before_state IS NOT NULL AND after_state IS NULL)
    )
  )
);

CREATE INDEX IF NOT EXISTS shadow_country_exception_history_recent_idx
  ON public.shadow_country_exception_history (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS shadow_country_exception_history_user_idx
  ON public.shadow_country_exception_history (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS shadow_country_exception_history_actor_idx
  ON public.shadow_country_exception_history (actor_admin_id, created_at DESC, id DESC);

-- Readable only through authenticated Backend service-role calls.
-- No client role has direct SELECT, INSERT, UPDATE or DELETE access.
ALTER TABLE public.shadow_country_exception_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shadow_country_exception_history
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.shadow_country_exception_history TO service_role;

-- Trigger records changes atomically with the underlying write, including
-- existing direct upserts/deletes and account deletion cascades.
-- Backend RPCs below attach the VERIFIED Admin identity to the same transaction.
CREATE OR REPLACE FUNCTION public.shadow_capture_country_exception_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action text;
  v_exception_id uuid;
  v_user_id uuid;
  v_user_name text;
  v_before jsonb;
  v_after jsonb;
  v_actor_id text;
  v_actor_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'CREATE';
    v_exception_id := NEW.id;
    v_user_id := NEW.user_id;
    v_after := jsonb_build_object(
      'mode', NEW.mode, 'overrides', NEW.overrides, 'expiresAt', NEW.expires_at
    );
  ELSIF TG_OP = 'UPDATE' THEN
    -- Do not manufacture a history event for an unchanged Save click.
    IF OLD.mode IS NOT DISTINCT FROM NEW.mode
      AND OLD.overrides IS NOT DISTINCT FROM NEW.overrides
      AND OLD.expires_at IS NOT DISTINCT FROM NEW.expires_at THEN
      RETURN NULL;
    END IF;
    v_action := 'UPDATE';
    v_exception_id := NEW.id;
    v_user_id := NEW.user_id;
    v_before := jsonb_build_object(
      'mode', OLD.mode, 'overrides', OLD.overrides, 'expiresAt', OLD.expires_at
    );
    v_after := jsonb_build_object(
      'mode', NEW.mode, 'overrides', NEW.overrides, 'expiresAt', NEW.expires_at
    );
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'REVOKE';
    v_exception_id := OLD.id;
    v_user_id := OLD.user_id;
    v_before := jsonb_build_object(
      'mode', OLD.mode, 'overrides', OLD.overrides, 'expiresAt', OLD.expires_at
    );
  ELSE
    RETURN NULL;
  END IF;

  -- Snapshot the target's name so that history can still identify the user
  -- after the profile is renamed or removed.
  SELECT COALESCE(NULLIF(btrim(u.name), ''), NULLIF(btrim(u.username), ''), v_user_id::text)
    INTO v_user_name
    FROM public.users AS u WHERE u.id = v_user_id;

  v_actor_id := NULLIF(btrim(current_setting('shadow.country_exception_actor_id', true)), '');
  v_actor_name := COALESCE(
    NULLIF(btrim(current_setting('shadow.country_exception_actor_name', true)), ''),
    'Unattributed (direct database write)'
  );

  INSERT INTO public.shadow_country_exception_history (
    exception_id, user_id, user_name, action,
    actor_admin_id, actor_name, before_state, after_state
  ) VALUES (
    v_exception_id, v_user_id, COALESCE(v_user_name, v_user_id::text), v_action,
    v_actor_id, v_actor_name, v_before, v_after
  );
  RETURN NULL; -- AFTER trigger: no modification to the original row
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_capture_country_exception_history()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS shadow_country_exception_history_write
  ON public.shadow_country_user_exceptions;
CREATE TRIGGER shadow_country_exception_history_write
AFTER INSERT OR UPDATE OR DELETE ON public.shadow_country_user_exceptions
FOR EACH ROW EXECUTE FUNCTION public.shadow_capture_country_exception_history();

-- Route these mutations through RPCs in the NEXT Backend step. The caller must
-- derive actor ID/name from verified req.admin, never from the request body.
-- Both the state change and history insert share ONE database transaction.
CREATE OR REPLACE FUNCTION public.shadow_save_country_exception(
  p_user_id uuid,
  p_mode text,
  p_overrides jsonb,
  p_actor_id text,
  p_actor_name text
)
RETURNS public.shadow_country_user_exceptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_saved public.shadow_country_user_exceptions%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_mode NOT IN ('cambodia_experience', 'all_eligible', 'custom')
    OR p_mode IS NULL OR p_overrides IS NULL OR jsonb_typeof(p_overrides) <> 'object' THEN
    RAISE EXCEPTION 'Invalid country exception' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('shadow.country_exception_actor_id', left(btrim(COALESCE(p_actor_id, '')), 120), true);
  PERFORM set_config('shadow.country_exception_actor_name', left(btrim(COALESCE(p_actor_name, '')), 160), true);

  INSERT INTO public.shadow_country_user_exceptions
    (user_id, mode, overrides, expires_at, updated_at)
  VALUES (p_user_id, p_mode, p_overrides, NULL, now())
  ON CONFLICT (user_id) DO UPDATE SET
    mode = EXCLUDED.mode,
    overrides = EXCLUDED.overrides,
    expires_at = NULL,
    updated_at = now()
  RETURNING * INTO v_saved;

  RETURN v_saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.shadow_revoke_country_exception(
  p_exception_id uuid,
  p_actor_id text,
  p_actor_name text
)
RETURNS public.shadow_country_user_exceptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted public.shadow_country_user_exceptions%ROWTYPE;
BEGIN
  IF p_exception_id IS NULL THEN
    RAISE EXCEPTION 'Invalid exception ID' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('shadow.country_exception_actor_id', left(btrim(COALESCE(p_actor_id, '')), 120), true);
  PERFORM set_config('shadow.country_exception_actor_name', left(btrim(COALESCE(p_actor_name, '')), 160), true);

  DELETE FROM public.shadow_country_user_exceptions
    WHERE id = p_exception_id
    RETURNING * INTO v_deleted;
  RETURN v_deleted;
END;
$$;

-- Supabase defaults to PUBLIC EXECUTE for new functions; explicitly revoke it.
REVOKE ALL ON FUNCTION public.shadow_save_country_exception(uuid, text, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_revoke_country_exception(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_save_country_exception(uuid, text, jsonb, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_revoke_country_exception(uuid, text, text)
  TO service_role;

COMMIT;

-- Optional non-mutating verification after running this script:
-- SELECT to_regclass('public.shadow_country_exception_history') AS history_table;
-- SELECT count(*) FROM public.shadow_country_exception_history;
