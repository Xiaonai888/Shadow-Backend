BEGIN;

CREATE FUNCTION public.telegram_event_admin_save_v1(p_id uuid, p_revision bigint, p_event jsonb, p_contents jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  old_row public.telegram_events%ROWTYPE;
  event_id_value uuid;
  event_status text := p_event->>'status';
  mode_value text := p_event->>'schedule_mode';
  slots_value jsonb := p_event->'schedule_slots';
  start_value date := (p_event->>'starts_on')::date;
  end_value date := (p_event->>'ends_on')::date;
  next_value timestamptz;
  item jsonb;
  changed_schedule boolean := true;
BEGIN
  IF jsonb_typeof(p_event) IS DISTINCT FROM 'object' OR jsonb_typeof(p_contents) IS DISTINCT FROM 'array' OR jsonb_array_length(p_contents) > 5 THEN
    RAISE EXCEPTION 'EVENT_INVALID_INPUT';
  END IF;
  IF event_status IS NULL OR event_status NOT IN ('draft','active','paused','archived') THEN RAISE EXCEPTION 'EVENT_INVALID_STATUS'; END IF;
  IF p_id IS NULL THEN
    IF p_revision IS NOT NULL OR event_status = 'archived' OR jsonb_array_length(p_contents) = 0 THEN RAISE EXCEPTION 'EVENT_INVALID_INPUT'; END IF;
  ELSE
    SELECT * INTO old_row FROM public.telegram_events WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'EVENT_NOT_FOUND'; END IF;
    IF p_revision IS DISTINCT FROM old_row.revision OR old_row.status = 'archived' THEN RAISE EXCEPTION 'EVENT_CONFLICT'; END IF;
    changed_schedule := (old_row.schedule_mode,old_row.schedule_slots,old_row.starts_on,old_row.ends_on) IS DISTINCT FROM (mode_value,slots_value,start_value,end_value);
  END IF;
  IF p_id IS NOT NULL AND event_status = 'archived' AND old_row.status = 'draft' AND old_row.schedule_slots = '[]'::jsonb AND NOT EXISTS (SELECT 1 FROM public.telegram_event_history WHERE event_id=p_id) THEN
    DELETE FROM public.telegram_event_contents WHERE event_id=p_id;
    DELETE FROM public.telegram_events WHERE id=p_id;
    RETURN p_id;
  END IF;
  IF NOT public.telegram_event_schedule_valid_v1(mode_value,slots_value,start_value,end_value) AND NOT (event_status = 'draft' AND slots_value = '[]'::jsonb AND start_value IS NULL AND end_value IS NULL) THEN
    RAISE EXCEPTION 'EVENT_INVALID_SCHEDULE';
  END IF;
  IF event_status = 'active' THEN
    IF p_id IS NOT NULL AND old_row.status = 'active' AND NOT changed_schedule THEN
      next_value := old_row.next_publish_at;
    ELSE
      next_value := public.telegram_event_next_publish_v1(mode_value,slots_value,start_value,end_value,statement_timestamp());
    END IF;
    IF next_value IS NULL THEN RAISE EXCEPTION 'EVENT_NO_FUTURE_SLOT'; END IF;
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.telegram_events(name,audience,status,schedule_mode,schedule_slots,starts_on,ends_on,next_publish_at)
    VALUES (p_event->>'name',p_event->>'audience',event_status,mode_value,slots_value,start_value,end_value,next_value) RETURNING id INTO event_id_value;
  ELSE
    event_id_value := p_id;
    UPDATE public.telegram_events SET name=p_event->>'name',audience=p_event->>'audience',status=event_status,schedule_mode=mode_value,schedule_slots=slots_value,starts_on=start_value,ends_on=end_value,next_publish_at=next_value,revision=revision+1 WHERE id=p_id;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_contents) LOOP
    INSERT INTO public.telegram_event_contents(event_id,language,enabled,message,image_url,image_key,button_label,button_url)
    VALUES (event_id_value,item->>'language',(item->>'enabled')::boolean,item->>'message',item->>'image_url',item->>'image_key',item->>'button_label',item->>'button_url')
    ON CONFLICT (event_id,language) DO UPDATE SET enabled=EXCLUDED.enabled,message=EXCLUDED.message,image_url=EXCLUDED.image_url,image_key=EXCLUDED.image_key,button_label=EXCLUDED.button_label,button_url=EXCLUDED.button_url;
  END LOOP;
  IF event_status = 'active' THEN
    IF NOT EXISTS (SELECT 1 FROM public.telegram_event_contents c WHERE c.event_id=event_id_value AND c.enabled) THEN RAISE EXCEPTION 'EVENT_NO_ENABLED_CONTENT'; END IF;
    IF EXISTS (SELECT 1 FROM public.telegram_event_contents c LEFT JOIN public.telegram_event_channels ch ON ch.language=c.language WHERE c.event_id=event_id_value AND c.enabled AND (ch.enabled IS DISTINCT FROM true OR ch.channel_id IS NULL)) THEN RAISE EXCEPTION 'EVENT_CHANNEL_NOT_READY'; END IF;
  END IF;
  RETURN event_id_value;
END;
$$;

REVOKE ALL ON FUNCTION public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb) TO service_role;

COMMIT;

SELECT
  to_regprocedure('public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb)') IS NOT NULL AS function_exists,
  NOT has_function_privilege('anon','public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb)','EXECUTE') AS anon_denied,
  NOT has_function_privilege('authenticated','public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb)','EXECUTE') AS authenticated_denied,
  has_function_privilege('service_role','public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb)','EXECUTE') AS service_role_allowed;
