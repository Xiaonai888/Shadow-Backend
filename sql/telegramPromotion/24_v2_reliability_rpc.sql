begin;

create or replace function public.telegram_promotion_v2_slot_pulse(p_language text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_settings public.telegram_promotion_settings%rowtype;
  v_tracking timestamptz;
  v_day date := (v_now at time zone 'Asia/Phnom_Penh')::date;
  v_start timestamptz;
  v_job public.telegram_promotion_v2_slot_jobs%rowtype;
  v_queue public.telegram_promotion_queue%rowtype;
  v_next timestamptz;
  v_status text;
  v_reason text;
  v_claim jsonb := null;
  v_found boolean;
  v_due timestamptz;
  v_expiry timestamptz;
  v_key text;
  v_seeded date;
  v_seed_start date;
  v_seed_end date;
  v_seed_day date;
  v_hour integer;
begin
  if p_language is null or p_language not in ('km','en') then raise exception 'Invalid reliability language'; end if;
  select * into v_settings from public.telegram_promotion_settings where language=p_language for update;
  if not found or not v_settings.enabled or v_settings.channel_id is null then return jsonb_build_object('claim',null,'nextAt',null,'disabled',true); end if;
  select tracked_from,seeded_through into v_tracking,v_seeded from public.telegram_promotion_v2_slot_tracking where language=p_language;
  if not found then
    select coalesce(min(x.due_at),v_now) into v_tracking
    from (select (v_day::timestamp+make_interval(hours=>h)) at time zone 'Asia/Phnom_Penh' as due_at from unnest(array[11,18,21]) h) x
    where x.due_at<=v_now and x.due_at+interval '3 hours'>v_now;
    v_tracking:=greatest(v_tracking,v_settings.enabled_at);
    insert into public.telegram_promotion_v2_slot_tracking(language,tracked_from) values(p_language,v_tracking);
  end if;
  v_start:=greatest(v_tracking,v_settings.enabled_at);
  v_seed_start:=greatest((v_start at time zone 'Asia/Phnom_Penh')::date,coalesce(v_seeded+1,(v_start at time zone 'Asia/Phnom_Penh')::date));
  v_seed_end:=least(v_day,v_seed_start+6);
  v_seed_day:=v_seed_start;
  while v_seed_day<=v_seed_end loop
    foreach v_hour in array array[11,18,21] loop
      v_due:=(v_seed_day::timestamp+make_interval(hours=>v_hour)) at time zone 'Asia/Phnom_Penh';
      v_expiry:=v_due+interval '3 hours';
      if v_due>=v_start then
        v_key:=to_char(v_due at time zone 'Asia/Phnom_Penh','YYYY-MM-DD"T"HH24:MI');
        insert into public.telegram_promotion_v2_slot_jobs(language,slot_key,due_at,expires_at,next_attempt_at)
        values(p_language,v_key,v_due,v_expiry,v_due) on conflict(language,slot_key) do nothing;
      end if;
    end loop;
    v_seed_day:=v_seed_day+1;
  end loop;
  if v_seed_start<=v_seed_end then
    update public.telegram_promotion_v2_slot_tracking set seeded_through=v_seed_end,updated_at=v_now where language=p_language;
  end if;
  for v_job in
    select * from public.telegram_promotion_v2_slot_jobs j
    where j.language=p_language and j.status in ('pending','processing','retrying','queued') and j.next_attempt_at<=v_now
    order by j.due_at for update
  loop
    if v_job.status='processing' and v_job.lease_until>v_now then continue; end if;
    select * into v_queue from public.telegram_promotion_queue q where q.language=p_language and q.job_key='slot:'||v_job.slot_key;
    v_found:=found;
    v_status:=null;
    v_reason:=null;
    v_next:=null;
    if v_found then
      case v_queue.status
        when 'sent' then v_status:='sent';
        when 'uncertain' then v_status:='uncertain'; v_reason:=coalesce(v_queue.last_error,'DELIVERY_UNKNOWN');
        when 'failed' then v_status:='failed'; v_reason:=coalesce(v_queue.last_error,'QUEUE_FAILED');
        when 'cancelled' then v_status:=case when v_now>=v_job.expires_at or v_queue.last_error='OPTIONAL_POST_EXPIRED' then 'missed' else 'failed' end; v_reason:=coalesce(v_queue.last_error,'QUEUE_CANCELLED');
        when 'sending' then
          if v_queue.lease_expires_at<=v_now then v_status:='uncertain'; v_reason:='SEND_LEASE_EXPIRED_VERIFY_TELEGRAM';
          else v_status:='queued'; v_next:=least(v_queue.lease_expires_at,v_now+interval '5 minutes'); end if;
        when 'ready' then
          if v_now>=v_job.expires_at then v_status:='missed'; v_reason:='QUEUE_EXPIRED_BEFORE_SEND';
          elsif v_queue.attempts>=5 then v_status:='failed'; v_reason:='QUEUE_ATTEMPTS_EXHAUSTED';
          else v_status:='queued'; v_reason:=v_queue.last_error; v_next:=least(v_job.expires_at,v_now+interval '5 minutes'); end if;
      end case;
      if v_status='queued' and v_job.deadline_checked_at is null and v_now<v_job.due_at+interval '15 minutes' then v_next:=least(v_next,v_job.due_at+interval '15 minutes'); end if;
    elsif v_job.queue_id is not null or v_job.status='queued' then
      v_status:='failed'; v_reason:='QUEUE_RECORD_MISSING';
    elsif v_now>=v_job.expires_at then
      v_status:='missed'; v_reason:=coalesce(v_job.last_reason,'SLOT_EXPIRED_BEFORE_QUEUE');
    elsif v_job.due_at<v_settings.enabled_at then
      v_status:='skipped'; v_reason:='CHANNEL_REENABLED_AFTER_SLOT';
    elsif v_job.attempts>=32 then
      v_status:='failed'; v_reason:='SLOT_ATTEMPTS_EXHAUSTED';
    elsif v_claim is null then
      update public.telegram_promotion_v2_slot_jobs j set status='processing',attempts=j.attempts+1,claim_id=gen_random_uuid(),lease_until=v_now+interval '2 minutes',next_attempt_at=v_now+interval '2 minutes',deadline_checked_at=case when v_now>=j.due_at+interval '15 minutes' then coalesce(j.deadline_checked_at,v_now) else j.deadline_checked_at end,updated_at=v_now
      where j.language=p_language and j.slot_key=v_job.slot_key returning * into v_job;
      v_claim:=jsonb_build_object('language',p_language,'slotKey',v_job.slot_key,'claimId',v_job.claim_id,'attempt',v_job.attempts,'dueAt',v_job.due_at,'expiresAt',v_job.expires_at,'stage',case when v_now>=v_job.due_at+interval '10 minutes' then 'fallback' when v_job.attempts>1 then 'retry' else 'main' end);
      continue;
    else
      continue;
    end if;
    update public.telegram_promotion_v2_slot_jobs j set status=v_status,queue_id=case when v_found then v_queue.id else j.queue_id end,claim_id=null,lease_until=null,next_attempt_at=v_next,last_reason=left(v_reason,500),deadline_checked_at=case when v_status<>'sent' and v_now>=j.due_at+interval '15 minutes' then coalesce(j.deadline_checked_at,v_now) else j.deadline_checked_at end,finished_at=case when v_status in ('sent','skipped','uncertain','missed','failed') then v_now else null end,updated_at=v_now
    where j.language=p_language and j.slot_key=v_job.slot_key;
  end loop;
  select min(x.t) into v_next from (
    select j.next_attempt_at as t from public.telegram_promotion_v2_slot_jobs j where j.language=p_language and j.status in ('pending','processing','retrying','queued')
    union all
    select ((v_day+d)::timestamp+make_interval(hours=>h)) at time zone 'Asia/Phnom_Penh' from unnest(array[0,1]) d cross join unnest(array[11,18,21]) h
    where (((v_day+d)::timestamp+make_interval(hours=>h)) at time zone 'Asia/Phnom_Penh')>v_now
  ) x;
  if v_seed_start<=v_seed_end and v_seed_end<v_day then v_next:=least(v_next,v_now+interval '5 seconds'); end if;
  return jsonb_build_object('claim',v_claim,'nextAt',v_next,'disabled',false);
end;
$$;

create or replace function public.telegram_promotion_v2_slot_finish(p_language text,p_slot_key text,p_claim_id uuid,p_outcome text,p_reason text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_job public.telegram_promotion_v2_slot_jobs%rowtype;
  v_queue public.telegram_promotion_queue%rowtype;
  v_status text;
  v_next timestamptz;
  v_reason text;
begin
  if p_language is null or p_language not in ('km','en') or p_claim_id is null or p_outcome is null or p_outcome not in ('queued','retry','skipped','failed') then raise exception 'Invalid reliability finish'; end if;
  perform 1 from public.telegram_promotion_settings where language=p_language for update;
  select * into v_job from public.telegram_promotion_v2_slot_jobs where language=p_language and slot_key=p_slot_key for update;
  if not found or v_job.status<>'processing' or v_job.claim_id is distinct from p_claim_id or v_job.lease_until<=v_now then return false; end if;
  select * into v_queue from public.telegram_promotion_queue where language=p_language and job_key='slot:'||p_slot_key;
  v_reason:=left(p_reason,500);
  if found then
    v_status:='queued'; v_next:=v_now;
  elsif p_outcome='skipped' then
    v_status:='skipped'; v_reason:=coalesce(v_reason,'POLICY_SKIP');
  elsif p_outcome='failed' then
    v_status:='failed'; v_reason:=coalesce(v_reason,'PREPARATION_FAILED');
  elsif v_now>=v_job.expires_at then
    v_status:='missed'; v_reason:=coalesce(v_reason,'SLOT_EXPIRED_BEFORE_QUEUE');
  else
    v_status:='retrying'; v_reason:=coalesce(v_reason,case when p_outcome='queued' then 'QUEUE_CONFIRMATION_MISSING' else 'PREPARATION_RETRY' end);
    v_next:=least(v_job.expires_at,case when v_now<v_job.due_at+interval '5 minutes' then v_job.due_at+interval '5 minutes' when v_now<v_job.due_at+interval '10 minutes' then v_job.due_at+interval '10 minutes' when v_now<v_job.due_at+interval '15 minutes' then v_job.due_at+interval '15 minutes' else v_now+interval '15 minutes' end);
  end if;
  update public.telegram_promotion_v2_slot_jobs j set status=v_status,queue_id=v_queue.id,next_attempt_at=v_next,claim_id=null,lease_until=null,last_reason=v_reason,deadline_checked_at=case when v_now>=j.due_at+interval '15 minutes' then coalesce(j.deadline_checked_at,v_now) else j.deadline_checked_at end,finished_at=case when v_status in ('skipped','failed','missed') then v_now else null end,updated_at=v_now where j.language=p_language and j.slot_key=p_slot_key;
  return true;
end;
$$;

revoke all on function public.telegram_promotion_v2_slot_pulse(text),public.telegram_promotion_v2_slot_finish(text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.telegram_promotion_v2_slot_pulse(text),public.telegram_promotion_v2_slot_finish(text,text,uuid,text,text) to service_role;
commit;
