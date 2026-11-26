begin;

create or replace function public.telegram_promotion_enqueue_v1(
  p_language text, p_job_key text, p_kind text, p_story_id uuid, p_episode_id uuid,
  p_author_id uuid, p_payload jsonb, p_due_at timestamptz, p_expires_at timestamptz
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
  v_enabled boolean;
begin
  select s.enabled into v_enabled from public.telegram_promotion_settings s where s.language = p_language for update;
  if not found or not v_enabled then return null; end if;
  if p_kind <> 'update' and (p_expires_at is null or p_expires_at <= now()) then return null; end if;
  select q.id into v_id from public.telegram_promotion_queue q where q.language = p_language and (q.job_key = p_job_key or (p_kind = 'update' and q.kind = 'update' and q.episode_id = p_episode_id)) limit 1;
  if v_id is not null then return v_id; end if;
  if p_kind <> 'update' and exists (
    select 1 from public.telegram_promotion_queue q
    where q.language = p_language and q.story_id = p_story_id
      and q.kind <> 'update' and q.status in ('ready','sending','sent','uncertain')
      and (q.status in ('ready','sending') or coalesce(q.sent_at,q.updated_at) >= now() - interval '14 days')
  ) then return null; end if;
  if p_kind = 'author' and (p_author_id is null or exists (
    select 1 from public.telegram_promotion_queue q where q.language = p_language and q.author_id = p_author_id
      and q.kind = 'author' and q.status in ('ready','sending','sent','uncertain')
      and (q.status in ('ready','sending') or coalesce(q.sent_at,q.updated_at) >= now() - interval '30 days')
  )) then return null; end if;
  insert into public.telegram_promotion_queue(language,job_key,kind,story_id,episode_id,author_id,payload,due_at,expires_at)
  values(p_language,p_job_key,p_kind,p_story_id,p_episode_id,p_author_id,p_payload,coalesce(p_due_at,now()),p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.telegram_promotion_claim_v1(p_language text)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_settings public.telegram_promotion_settings%rowtype;
  v_job public.telegram_promotion_queue%rowtype;
begin
  select * into v_settings from public.telegram_promotion_settings where language = p_language for update skip locked;
  if not found or not v_settings.enabled or v_settings.channel_id is null then return null; end if;
  update public.telegram_promotion_queue set status='uncertain',lease_expires_at=null,last_error='SEND_LEASE_EXPIRED: verify Telegram before retry',updated_at=now()
    where language=p_language and status='sending' and lease_expires_at <= now();
  update public.telegram_promotion_queue set status='cancelled',last_error='OPTIONAL_POST_EXPIRED',updated_at=now()
    where language=p_language and status='ready' and expires_at <= now();
  if v_settings.next_send_at > now() or exists (select 1 from public.telegram_promotion_queue where language=p_language and status='sending') then return null; end if;
  select * into v_job from public.telegram_promotion_queue where language=p_language and status='ready' and attempts < 5 and due_at <= now()
    order by case when kind='update' then 0 else 1 end, due_at, created_at, id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.telegram_promotion_queue set status='sending',attempts=attempts+1,lease_expires_at=now()+interval '2 minutes',telegram_chat_id=v_settings.channel_id,updated_at=now()
    where id=v_job.id returning * into v_job;
  update public.telegram_promotion_settings set next_send_at=now()+make_interval(secs=>v_settings.gap_seconds),updated_at=now() where language=p_language;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.telegram_promotion_finish_v1(
  p_id uuid, p_attempt integer, p_outcome text, p_error text default null,
  p_message_id bigint default null, p_retry_seconds integer default null
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v_language text;
  v_settings public.telegram_promotion_settings%rowtype;
  v_job public.telegram_promotion_queue%rowtype;
  v_status text;
  v_retry integer;
begin
  if p_outcome not in ('sent','retry','failed','uncertain','cancelled') or p_outcome is null then raise exception 'Invalid promotion outcome'; end if;
  if p_outcome='sent' and (p_message_id is null or p_message_id <= 0) then raise exception 'Missing Telegram message ID'; end if;
  select language into v_language from public.telegram_promotion_queue where id=p_id;
  if not found then return false; end if;
  select * into v_settings from public.telegram_promotion_settings where language=v_language for update;
  select * into v_job from public.telegram_promotion_queue where id=p_id for update;
  if not found or v_job.status <> 'sending' or v_job.attempts <> p_attempt then return false; end if;
  v_status := case when p_outcome='retry' and v_job.attempts < 5 then 'ready' when p_outcome='retry' then 'failed' else p_outcome end;
  v_retry := greatest(60,coalesce(p_retry_seconds,60));
  update public.telegram_promotion_queue set status=v_status,lease_expires_at=null,
    due_at=case when v_status='ready' then now()+make_interval(secs=>v_retry) else due_at end,
    sent_at=case when v_status='sent' then now() else null end,
    telegram_message_id=case when v_status='sent' then p_message_id else null end,
    last_error=case when v_status='sent' then null else left(p_error,500) end,updated_at=now()
    where id=p_id;
  update public.telegram_promotion_settings set next_send_at=greatest(next_send_at,now()+make_interval(secs=>case when p_outcome='retry' then greatest(v_retry,v_settings.gap_seconds) else v_settings.gap_seconds end)),updated_at=now() where language=v_language;
  return true;
end;
$$;

create or replace function public.telegram_promotion_next_due_v1()
returns timestamptz
language sql stable security invoker set search_path = '' as $$
  select min(due) from (
    select greatest(s.next_send_at,q.due_at) as due
    from public.telegram_promotion_settings s join lateral (
      select min(due_at) as due_at from public.telegram_promotion_queue where language=s.language and status='ready' and attempts<5 and (expires_at is null or expires_at>now())
    ) q on q.due_at is not null
    where s.enabled and not exists(select 1 from public.telegram_promotion_queue a where a.language=s.language and a.status='sending')
    union all
    select q.lease_expires_at from public.telegram_promotion_queue q join public.telegram_promotion_settings s on s.language=q.language where s.enabled and q.status='sending'
  ) t;
$$;

revoke all on function public.telegram_promotion_enqueue_v1(text,text,text,uuid,uuid,uuid,jsonb,timestamptz,timestamptz), public.telegram_promotion_claim_v1(text), public.telegram_promotion_finish_v1(uuid,integer,text,text,bigint,integer), public.telegram_promotion_next_due_v1() from public, anon, authenticated;
grant execute on function public.telegram_promotion_enqueue_v1(text,text,text,uuid,uuid,uuid,jsonb,timestamptz,timestamptz), public.telegram_promotion_claim_v1(text), public.telegram_promotion_finish_v1(uuid,integer,text,text,bigint,integer), public.telegram_promotion_next_due_v1() to service_role;

commit;
