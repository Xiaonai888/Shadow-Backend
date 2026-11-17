BEGIN;

CREATE TABLE IF NOT EXISTS public.shadow_read_event_auto_settings (
  setting_id smallint PRIMARY KEY DEFAULT 1 CHECK (setting_id = 1),
  auto_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid
);

ALTER TABLE public.shadow_read_event_auto_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shadow_read_event_auto_settings FROM anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.shadow_read_event_auto_settings TO service_role;

INSERT INTO public.shadow_read_event_auto_settings (setting_id, auto_enabled)
VALUES (1, true)
ON CONFLICT (setting_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.shadow_read_event_auto_activate(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_system_id uuid := '00000000-0000-4000-8000-000000000099'::uuid;
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_start date;
  v_enabled boolean;
  v_group text;
  v_auto boolean;
  v_result jsonb;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Read Event ID required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shadow_read_event_auto_activate:' || p_event_id::text, 0)
  );

  SELECT a.auto_enabled INTO v_auto
  FROM public.shadow_read_event_auto_settings AS a
  WHERE a.setting_id = 1;

  IF v_auto IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'activated', false,
      'reason', 'automation_disabled', 'event_id', p_event_id);
  END IF;

  SELECT w.starts_on, w.is_enabled, w.audience_group
  INTO v_start, v_enabled, v_group
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id
  FOR UPDATE;

  IF NOT FOUND OR v_group IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Read Event not found or not eligible' USING ERRCODE = '22023';
  END IF;

  IF v_today < v_start OR v_today >= v_start + 7 THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'activated', false,
      'reason', 'outside_event_window', 'event_id', p_event_id);
  END IF;

  IF v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'activated', false,
      'reason', 'already_enabled', 'event_id', p_event_id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.shadow_read_event_admin_status_history AS h
    WHERE h.event_id = p_event_id
      AND h.new_enabled = false
      AND h.admin_id <> v_system_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'activated', false,
      'reason', 'manual_disabled', 'event_id', p_event_id);
  END IF;

  v_result := public.shadow_read_event_set_enabled(p_event_id, true, v_system_id);
  IF v_result ->> 'ok' IS DISTINCT FROM 'true'
     OR v_result ->> 'is_enabled' IS DISTINCT FROM 'true'
     OR v_result ->> 'event_id' IS DISTINCT FROM p_event_id::text THEN
    RAISE EXCEPTION 'Automatic Read Event enable was not verified';
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'activated', true,
    'reason', 'enabled', 'event_id', p_event_id, 'starts_on', v_start);
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_auto_activate(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_auto_activate(uuid) TO service_role;

COMMIT;
