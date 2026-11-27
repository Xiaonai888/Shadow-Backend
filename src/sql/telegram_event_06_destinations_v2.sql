BEGIN;

ALTER TABLE public.telegram_event_channels
  ADD COLUMN group_id text UNIQUE CHECK (group_id IS NULL OR group_id ~ '^-[1-9][0-9]{0,15}$'),
  ADD COLUMN group_name text CHECK (group_name IS NULL OR char_length(group_name)<=200),
  ADD CONSTRAINT telegram_event_distinct_targets CHECK (group_id IS NULL OR channel_id IS DISTINCT FROM group_id);

ALTER TABLE public.telegram_event_history
  ADD COLUMN destination_kind text NOT NULL DEFAULT 'channel' CHECK (destination_kind IN ('channel','group'));
ALTER TABLE public.telegram_event_history DROP CONSTRAINT telegram_event_history_event_id_language_job_key_key;
ALTER TABLE public.telegram_event_history ADD CONSTRAINT telegram_event_history_target_job_key UNIQUE (event_id,language,destination_kind,job_key);
DROP INDEX public.telegram_event_history_slot_idx;
CREATE UNIQUE INDEX telegram_event_history_slot_idx ON public.telegram_event_history(event_id,language,destination_kind,scheduled_at) WHERE job_kind='scheduled';

CREATE OR REPLACE FUNCTION public.telegram_event_prepare_v1() RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  e public.telegram_events%ROWTYPE;
  t timestamptz := statement_timestamp();
  next_value timestamptz;
  cutoff timestamptz := t - interval '15 minutes';
  prepared integer := 0;
BEGIN
  WITH stale AS (
    SELECT id FROM public.telegram_event_history
    WHERE status='sending' AND lease_until<=t ORDER BY lease_until,id LIMIT 50 FOR UPDATE SKIP LOCKED
  ) UPDATE public.telegram_event_history h SET status='uncertain',lease_id=NULL,lease_until=NULL,
      error_code='LEASE_EXPIRED',error_message='Delivery outcome unknown; review channel before retrying',finished_at=t
    FROM stale WHERE h.id=stale.id;
  WITH stale AS (
    SELECT id FROM public.telegram_event_history
    WHERE status IN ('pending','retry') AND expires_at<=t ORDER BY available_at,id LIMIT 50 FOR UPDATE SKIP LOCKED
  ) UPDATE public.telegram_event_history h SET status='skipped',error_code='EXPIRED',error_message='Publish window expired',finished_at=t
    FROM stale WHERE h.id=stale.id;
  FOR e IN SELECT * FROM public.telegram_events WHERE status='active' AND next_publish_at<=t
    ORDER BY next_publish_at,id LIMIT 20 FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.telegram_event_history(event_id,language,channel_id,destination_kind,job_kind,job_key,scheduled_at,available_at,expires_at,status,error_code,error_message,finished_at)
    SELECT e.id,c.language,d.chat_id,d.kind,'scheduled','slot:'||to_char(e.next_publish_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI"Z"'),
      e.next_publish_at,t,e.next_publish_at+interval '15 minutes',
      CASE WHEN e.next_publish_at<=cutoff OR d.chat_id IS NULL THEN 'skipped' ELSE 'pending' END,
      CASE WHEN e.next_publish_at<=cutoff THEN 'MISSED_SLOT' WHEN d.chat_id IS NULL THEN 'CHANNEL_DISABLED' END,
      CASE WHEN e.next_publish_at<=cutoff THEN 'Publish window expired' WHEN d.chat_id IS NULL THEN 'No Telegram destination configured' END,
      CASE WHEN e.next_publish_at<=cutoff OR d.chat_id IS NULL THEN t END
    FROM public.telegram_event_contents c JOIN public.telegram_event_channels ch ON ch.language=c.language
    CROSS JOIN LATERAL (
      SELECT v.kind,v.chat_id FROM (VALUES ('channel',CASE WHEN ch.enabled THEN ch.channel_id END),('group',ch.group_id)) AS v(kind,chat_id) WHERE v.chat_id IS NOT NULL
      UNION ALL SELECT 'channel',NULL::text WHERE (NOT ch.enabled OR ch.channel_id IS NULL) AND ch.group_id IS NULL
    ) d
    WHERE c.event_id=e.id AND c.enabled
    ON CONFLICT DO NOTHING;
    next_value:=public.telegram_event_next_publish_v1(e.schedule_mode,e.schedule_slots,e.starts_on,e.ends_on,greatest(e.next_publish_at,cutoff));
    UPDATE public.telegram_events SET next_publish_at=next_value,
      status=CASE WHEN next_value IS NULL THEN 'completed' ELSE 'active' END,
      revision=revision+CASE WHEN next_value IS NULL THEN 1 ELSE 0 END WHERE id=e.id;
    prepared:=prepared+1;
  END LOOP;
  RETURN prepared;
END;
$$;

CREATE OR REPLACE FUNCTION public.telegram_event_manual_v1(p_event uuid,p_language text,p_request uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  e public.telegram_events%ROWTYPE;
  ch public.telegram_event_channels%ROWTYPE;
  t timestamptz := statement_timestamp();
  job uuid;
BEGIN
  IF p_request IS NULL OR p_language IS NULL OR p_language NOT IN ('km','en','zh','ko','ja') THEN RAISE EXCEPTION 'EVENT_INVALID_INPUT'; END IF;
  SELECT * INTO e FROM public.telegram_events WHERE id=p_event FOR UPDATE;
  IF NOT FOUND OR e.status='archived' THEN RAISE EXCEPTION 'EVENT_NOT_FOUND'; END IF;
  SELECT id INTO job FROM public.telegram_event_history WHERE event_id=p_event AND language=p_language AND job_key='manual:'||p_request::text ORDER BY destination_kind LIMIT 1;
  IF FOUND THEN RETURN job; END IF;
  IF e.status NOT IN ('active','paused','completed') THEN RAISE EXCEPTION 'EVENT_INVALID_STATUS'; END IF;
  SELECT * INTO ch FROM public.telegram_event_channels WHERE language=p_language;
  IF NOT FOUND OR ((NOT ch.enabled OR ch.channel_id IS NULL) AND ch.group_id IS NULL) THEN RAISE EXCEPTION 'EVENT_CHANNEL_NOT_READY'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.telegram_event_contents WHERE event_id=p_event AND language=p_language AND enabled) THEN RAISE EXCEPTION 'EVENT_NO_ENABLED_CONTENT'; END IF;
  INSERT INTO public.telegram_event_history(event_id,language,channel_id,destination_kind,job_kind,job_key,scheduled_at,available_at,expires_at)
    SELECT p_event,p_language,v.chat_id,v.kind,'manual:'||p_request::text,t,t,t+interval '15 minutes'
    FROM (VALUES ('channel',CASE WHEN ch.enabled THEN ch.channel_id END),('group',ch.group_id)) v(kind,chat_id)
    WHERE v.chat_id IS NOT NULL;
  SELECT id INTO job FROM public.telegram_event_history WHERE event_id=p_event AND language=p_language AND job_key='manual:'||p_request::text ORDER BY destination_kind LIMIT 1;
  RETURN job;
END;
$$;

CREATE OR REPLACE FUNCTION public.telegram_event_claim_v1() RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  j public.telegram_event_history%ROWTYPE;
  e public.telegram_events%ROWTYPE;
  c public.telegram_event_contents%ROWTYPE;
  ch public.telegram_event_channels%ROWTYPE;
  t timestamptz := statement_timestamp();
  reason text;
  i integer;
BEGIN
  FOR i IN 1..20 LOOP
    SELECT * INTO j FROM public.telegram_event_history
      WHERE status IN ('pending','retry') AND available_at<=t AND expires_at>t
      ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO e FROM public.telegram_events WHERE id=j.event_id;
    SELECT * INTO c FROM public.telegram_event_contents WHERE event_id=j.event_id AND language=j.language;
    SELECT * INTO ch FROM public.telegram_event_channels WHERE language=j.language;
    reason:=NULL;
    IF e.status IS NULL OR e.status NOT IN ('active','completed','paused') OR (j.job_kind='scheduled' AND e.status='paused') THEN reason:='EVENT_INACTIVE';
    ELSIF j.job_kind='scheduled' AND public.telegram_event_next_publish_v1(e.schedule_mode,e.schedule_slots,e.starts_on,e.ends_on,j.scheduled_at-interval '1 millisecond') IS DISTINCT FROM j.scheduled_at THEN reason:='SCHEDULE_CHANGED';
    ELSIF c.enabled IS DISTINCT FROM true THEN reason:='LANGUAGE_DISABLED';
    ELSIF (j.destination_kind='channel' AND (ch.enabled IS DISTINCT FROM true OR ch.channel_id IS NULL OR ch.channel_id IS DISTINCT FROM j.channel_id)) OR (j.destination_kind='group' AND (ch.group_id IS NULL OR ch.group_id IS DISTINCT FROM j.channel_id)) THEN reason:='DESTINATION_CHANGED';
    ELSIF j.attempts>=5 THEN reason:='ATTEMPT_LIMIT'; END IF;
    IF reason IS NOT NULL THEN
      UPDATE public.telegram_event_history SET status='skipped',error_code=reason,finished_at=t WHERE id=j.id;
      CONTINUE;
    END IF;
    UPDATE public.telegram_event_history SET status='sending',attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=t+interval '60 seconds',error_code=NULL,error_message=NULL
      WHERE id=j.id RETURNING * INTO j;
    RETURN jsonb_build_object('id',j.id,'event_id',j.event_id,'language',j.language,'channel_id',j.channel_id,'destination_kind',j.destination_kind,'attempts',j.attempts,'lease_id',j.lease_id,
      'expires_at',j.expires_at,'message',c.message,'image_url',c.image_url,'image_key',c.image_key,'button_label',c.button_label,'button_url',c.button_url,
      'photo_file_id',c.photo_file_id,'photo_bot_key',c.photo_bot_key);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.telegram_event_admin_save_v1(p_id uuid, p_revision bigint, p_event jsonb, p_contents jsonb)
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
    IF EXISTS (SELECT 1 FROM public.telegram_event_contents c LEFT JOIN public.telegram_event_channels ch ON ch.language=c.language WHERE c.event_id=event_id_value AND c.enabled AND (ch.language IS NULL OR ((ch.enabled IS DISTINCT FROM true OR ch.channel_id IS NULL) AND ch.group_id IS NULL))) THEN RAISE EXCEPTION 'EVENT_CHANNEL_NOT_READY'; END IF;
  END IF;
  RETURN event_id_value;
END;
$$;

REVOKE ALL ON FUNCTION public.telegram_event_prepare_v1(),public.telegram_event_manual_v1(uuid,text,uuid),public.telegram_event_claim_v1(),public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_event_prepare_v1(),public.telegram_event_manual_v1(uuid,text,uuid),public.telegram_event_claim_v1(),public.telegram_event_admin_save_v1(uuid,bigint,jsonb,jsonb) TO service_role;
COMMIT;
