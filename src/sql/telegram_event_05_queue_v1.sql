BEGIN;

CREATE FUNCTION public.telegram_event_prepare_v1() RETURNS integer
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
    INSERT INTO public.telegram_event_history(event_id,language,channel_id,job_kind,job_key,scheduled_at,available_at,expires_at,status,error_code,error_message,finished_at)
    SELECT e.id,c.language,ch.channel_id,'scheduled','slot:'||to_char(e.next_publish_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI"Z"'),
      e.next_publish_at,t,e.next_publish_at+interval '15 minutes',
      CASE WHEN e.next_publish_at<=cutoff OR NOT ch.enabled OR ch.channel_id IS NULL THEN 'skipped' ELSE 'pending' END,
      CASE WHEN e.next_publish_at<=cutoff THEN 'MISSED_SLOT' WHEN NOT ch.enabled OR ch.channel_id IS NULL THEN 'CHANNEL_DISABLED' END,
      CASE WHEN e.next_publish_at<=cutoff THEN 'Publish window expired' WHEN NOT ch.enabled OR ch.channel_id IS NULL THEN 'Channel not enabled' END,
      CASE WHEN e.next_publish_at<=cutoff OR NOT ch.enabled OR ch.channel_id IS NULL THEN t END
    FROM public.telegram_event_contents c JOIN public.telegram_event_channels ch ON ch.language=c.language
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

CREATE FUNCTION public.telegram_event_manual_v1(p_event uuid,p_language text,p_request uuid) RETURNS uuid
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
  SELECT id INTO job FROM public.telegram_event_history WHERE event_id=p_event AND language=p_language AND job_key='manual:'||p_request::text;
  IF FOUND THEN RETURN job; END IF;
  IF e.status NOT IN ('active','paused','completed') THEN RAISE EXCEPTION 'EVENT_INVALID_STATUS'; END IF;
  SELECT * INTO ch FROM public.telegram_event_channels WHERE language=p_language;
  IF NOT FOUND OR NOT ch.enabled OR ch.channel_id IS NULL THEN RAISE EXCEPTION 'EVENT_CHANNEL_NOT_READY'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.telegram_event_contents WHERE event_id=p_event AND language=p_language AND enabled) THEN RAISE EXCEPTION 'EVENT_NO_ENABLED_CONTENT'; END IF;
  INSERT INTO public.telegram_event_history(event_id,language,channel_id,job_kind,job_key,scheduled_at,available_at,expires_at)
    VALUES(p_event,p_language,ch.channel_id,'manual','manual:'||p_request::text,t,t,t+interval '15 minutes') RETURNING id INTO job;
  RETURN job;
END;
$$;

CREATE FUNCTION public.telegram_event_claim_v1() RETURNS jsonb
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
    ELSIF ch.enabled IS DISTINCT FROM true OR ch.channel_id IS NULL OR ch.channel_id IS DISTINCT FROM j.channel_id THEN reason:='CHANNEL_CHANGED';
    ELSIF j.attempts>=5 THEN reason:='ATTEMPT_LIMIT'; END IF;
    IF reason IS NOT NULL THEN
      UPDATE public.telegram_event_history SET status='skipped',error_code=reason,finished_at=t WHERE id=j.id;
      CONTINUE;
    END IF;
    UPDATE public.telegram_event_history SET status='sending',attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=t+interval '60 seconds',error_code=NULL,error_message=NULL
      WHERE id=j.id RETURNING * INTO j;
    RETURN jsonb_build_object('id',j.id,'event_id',j.event_id,'language',j.language,'channel_id',j.channel_id,'attempts',j.attempts,'lease_id',j.lease_id,
      'expires_at',j.expires_at,'message',c.message,'image_url',c.image_url,'image_key',c.image_key,'button_label',c.button_label,'button_url',c.button_url,
      'photo_file_id',c.photo_file_id,'photo_bot_key',c.photo_bot_key);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.telegram_event_finish_v1(p_id uuid,p_lease uuid,p_outcome text,p_code text,p_error text,p_message_id bigint,p_retry_seconds integer,p_image_key text,p_file_id text,p_bot_key text) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  j public.telegram_event_history%ROWTYPE;
  t timestamptz := statement_timestamp();
  outcome text := p_outcome;
  retry_at timestamptz;
BEGIN
  IF outcome IS NULL OR outcome NOT IN ('sent','failed','uncertain','retry') THEN RAISE EXCEPTION 'EVENT_INVALID_OUTCOME'; END IF;
  IF outcome='sent' AND (p_message_id IS NULL OR p_message_id<=0) THEN RAISE EXCEPTION 'EVENT_INVALID_MESSAGE_ID'; END IF;
  SELECT * INTO j FROM public.telegram_event_history WHERE id=p_id AND status='sending' AND lease_id=p_lease AND lease_until>t FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF outcome='retry' THEN
    retry_at:=t+make_interval(secs=>greatest(1,least(coalesce(p_retry_seconds,60),86400)));
    IF j.attempts>=5 OR retry_at>=j.expires_at THEN outcome:='failed'; END IF;
  END IF;
  UPDATE public.telegram_event_history SET status=outcome,lease_id=NULL,lease_until=NULL,
    available_at=CASE WHEN outcome='retry' THEN retry_at ELSE available_at END,
    error_code=CASE WHEN outcome='sent' THEN NULL ELSE left(p_code,100) END,
    error_message=CASE WHEN outcome='sent' THEN NULL ELSE left(regexp_replace(p_error,'[0-9]+:[A-Za-z0-9_-]{10,}','[redacted]','g'),500) END,
    telegram_message_id=CASE WHEN outcome='sent' THEN p_message_id ELSE NULL END,
    finished_at=CASE WHEN outcome='retry' THEN NULL ELSE t END WHERE id=j.id;
  IF outcome='sent' AND p_image_key IS NOT NULL AND char_length(p_file_id) BETWEEN 1 AND 1024 AND p_bot_key ~ '^[0-9a-f]{64}$' THEN
    UPDATE public.telegram_event_contents SET photo_file_id=p_file_id,photo_bot_key=p_bot_key
      WHERE event_id=j.event_id AND language=j.language AND image_key=p_image_key;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION public.telegram_event_next_due_v1() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT min(due) FROM (
    (SELECT next_publish_at AS due FROM public.telegram_events WHERE status='active' ORDER BY next_publish_at LIMIT 1)
    UNION ALL
    (SELECT available_at AS due FROM public.telegram_event_history WHERE status IN ('pending','retry') ORDER BY available_at LIMIT 1)
    UNION ALL
    (SELECT lease_until AS due FROM public.telegram_event_history WHERE status='sending' ORDER BY lease_until LIMIT 1)
  ) AS next_times;
$$;

REVOKE ALL ON FUNCTION public.telegram_event_prepare_v1(),public.telegram_event_manual_v1(uuid,text,uuid),public.telegram_event_claim_v1(),public.telegram_event_finish_v1(uuid,uuid,text,text,text,bigint,integer,text,text,text),public.telegram_event_next_due_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_event_prepare_v1(),public.telegram_event_manual_v1(uuid,text,uuid),public.telegram_event_claim_v1(),public.telegram_event_finish_v1(uuid,uuid,text,text,text,bigint,integer,text,text,text),public.telegram_event_next_due_v1() TO service_role;
COMMIT;

SELECT p::text AS function_name,
  to_regprocedure(p) IS NOT NULL AS function_exists,
  NOT has_function_privilege('anon',p,'EXECUTE') AS anon_denied,
  NOT has_function_privilege('authenticated',p,'EXECUTE') AS authenticated_denied,
  has_function_privilege('service_role',p,'EXECUTE') AS service_role_allowed
FROM unnest(ARRAY['public.telegram_event_prepare_v1()','public.telegram_event_manual_v1(uuid,text,uuid)','public.telegram_event_claim_v1()','public.telegram_event_finish_v1(uuid,uuid,text,text,text,bigint,integer,text,text,text)','public.telegram_event_next_due_v1()']) AS f(p);
