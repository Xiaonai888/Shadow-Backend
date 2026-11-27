begin;

alter table public.telegram_promotion_v2_update_groups add column if not exists edit_claim_id uuid;
alter table public.telegram_promotion_v2_update_groups add column if not exists edit_claim_revision integer;

create or replace function public.telegram_promotion_v2_finish_update(p_id uuid,p_attempt integer,p_outcome text,p_revision integer,p_error text default null,p_message_ids bigint[] default null,p_media_group_id text default null,p_retry_seconds integer default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare
  v_language text;
  v_group public.telegram_promotion_v2_update_groups%rowtype;
begin
  select language into v_language from public.telegram_promotion_v2_update_groups where queue_id=p_id;
  if not found then return false; end if;
  perform 1 from public.telegram_promotion_settings where language=v_language for update;
  select * into v_group from public.telegram_promotion_v2_update_groups where queue_id=p_id for update;
  if not found then return false; end if;
  if p_revision is null or p_revision<1 or p_revision>v_group.desired_revision then raise exception 'Invalid update revision'; end if;
  if not public.telegram_promotion_v2_finish(p_id,p_attempt,p_outcome,p_error,p_message_ids,p_media_group_id,p_retry_seconds) then return false; end if;
  if p_outcome='sent' then
    update public.telegram_promotion_v2_update_groups set applied_revision=p_revision,next_edit_at=case when desired_revision>p_revision then now() else null end,edit_attempts=0,last_edit_error=null,updated_at=now() where queue_id=p_id;
  end if;
  return true;
end;
$$;

create or replace function public.telegram_promotion_v2_claim_edit(p_language text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_settings public.telegram_promotion_settings%rowtype;
  v_group public.telegram_promotion_v2_update_groups%rowtype;
  v_job public.telegram_promotion_queue%rowtype;
begin
  select * into v_settings from public.telegram_promotion_settings where language=p_language for update skip locked;
  if not found or not v_settings.enabled or v_settings.channel_id is null or v_settings.next_send_at>now() then return null; end if;
  if exists(select 1 from public.telegram_promotion_queue where language=p_language and (status='sending' or (kind='update' and status='ready' and due_at<=now() and attempts<5))) then return null; end if;
  if exists(select 1 from public.telegram_promotion_v2_update_groups where language=p_language and edit_lease_until>now()) then return null; end if;
  select g.* into v_group from public.telegram_promotion_v2_update_groups g join public.telegram_promotion_queue q on q.id=g.queue_id where g.language=p_language and q.status='sent' and q.telegram_chat_id=v_settings.channel_id and q.telegram_message_id is not null and g.applied_revision<g.desired_revision and g.next_edit_at<=now() and g.edit_attempts<5 and (g.edit_lease_until is null or g.edit_lease_until<=now()) order by g.next_edit_at,g.first_published_at,g.queue_id limit 1 for update of g skip locked;
  if not found then return null; end if;
  select * into v_job from public.telegram_promotion_queue where id=v_group.queue_id;
  update public.telegram_promotion_v2_update_groups set edit_claim_id=gen_random_uuid(),edit_claim_revision=desired_revision,edit_attempts=edit_attempts+1,edit_lease_until=now()+interval '2 minutes',updated_at=now() where queue_id=v_group.queue_id returning * into v_group;
  update public.telegram_promotion_settings set next_send_at=now()+make_interval(secs=>greatest(gap_seconds,120)),updated_at=now() where language=p_language;
  return jsonb_build_object('queueId',v_group.queue_id,'claimId',v_group.edit_claim_id,'revision',v_group.edit_claim_revision,'attempt',v_group.edit_attempts,'chatId',v_job.telegram_chat_id,'messageId',v_job.telegram_message_id,'payload',v_job.payload);
end;
$$;

create or replace function public.telegram_promotion_v2_finish_edit(p_id uuid,p_claim_id uuid,p_outcome text,p_error text default null,p_retry_seconds integer default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare
  v_language text;
  v_group public.telegram_promotion_v2_update_groups%rowtype;
  v_delay integer;
begin
  if p_outcome is null or p_outcome not in ('edited','retry','failed') or p_claim_id is null then raise exception 'Invalid edit outcome'; end if;
  select language into v_language from public.telegram_promotion_v2_update_groups where queue_id=p_id;
  if not found then return false; end if;
  perform 1 from public.telegram_promotion_settings where language=v_language for update;
  select * into v_group from public.telegram_promotion_v2_update_groups where queue_id=p_id for update;
  if not found or v_group.edit_claim_id is distinct from p_claim_id or v_group.edit_claim_revision is null then return false; end if;
  v_delay:=greatest(60,coalesce(p_retry_seconds,300));
  update public.telegram_promotion_v2_update_groups set
    applied_revision=case when p_outcome='edited' then greatest(applied_revision,edit_claim_revision) else applied_revision end,
    next_edit_at=case when p_outcome='edited' and desired_revision>edit_claim_revision then now() when p_outcome='retry' and (edit_attempts<5 or desired_revision>edit_claim_revision) then now()+make_interval(secs=>v_delay) when p_outcome='failed' and desired_revision>edit_claim_revision then now()+interval '5 minutes' else null end,
    edit_attempts=case when p_outcome='edited' or desired_revision>edit_claim_revision then 0 else edit_attempts end,
    last_edit_error=case when p_outcome='edited' then null else left(coalesce(p_error,'EDIT_FAILED'),500) end,
    edit_claim_id=null,edit_claim_revision=null,edit_lease_until=null,updated_at=now() where queue_id=p_id;
  if p_outcome='retry' then update public.telegram_promotion_settings set next_send_at=greatest(next_send_at,now()+make_interval(secs=>v_delay)),updated_at=now() where language=v_language; end if;
  return true;
end;
$$;

create or replace function public.telegram_promotion_v2_next_edit_due(p_language text)
returns timestamptz language sql stable security invoker set search_path='' as $$
select min(greatest(g.next_edit_at,s.next_send_at,coalesce(g.edit_lease_until,'-infinity'::timestamptz)))
from public.telegram_promotion_v2_update_groups g join public.telegram_promotion_queue q on q.id=g.queue_id join public.telegram_promotion_settings s on s.language=g.language
where g.language=p_language and s.enabled and q.status='sent' and q.telegram_chat_id=s.channel_id and g.applied_revision<g.desired_revision and g.edit_attempts<5 and g.next_edit_at is not null;
$$;

revoke all on function public.telegram_promotion_v2_finish_update(uuid,integer,text,integer,text,bigint[],text,integer),public.telegram_promotion_v2_claim_edit(text),public.telegram_promotion_v2_finish_edit(uuid,uuid,text,text,integer),public.telegram_promotion_v2_next_edit_due(text) from public,anon,authenticated;
grant execute on function public.telegram_promotion_v2_finish_update(uuid,integer,text,integer,text,bigint[],text,integer),public.telegram_promotion_v2_claim_edit(text),public.telegram_promotion_v2_finish_edit(uuid,uuid,text,text,integer),public.telegram_promotion_v2_next_edit_due(text) to service_role;
commit;
