begin;

create or replace function public.social_promotion_account_cap_v5()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  start_at timestamptz;
begin
  if new.owner_type<>'admin' or new.owner_id<>'shadow' or new.rule_revision is null then return new; end if;
  perform 1 from public.social_media_connections where id=new.connection_id for update;
  start_at:=date_trunc('day',new.scheduled_at at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh';
  if (select count(*) from public.social_media_jobs j where j.connection_id=new.connection_id and j.owner_type='admin' and j.owner_id='shadow' and j.scheduled_at>=start_at and j.scheduled_at<start_at+interval '24 hours')>=3 then
    raise exception using errcode='23514',message='SOCIAL_ACCOUNT_DAILY_LIMIT';
  end if;
  return new;
end;
$$;
drop trigger if exists social_promotion_account_cap_v5 on public.social_media_jobs;
create trigger social_promotion_account_cap_v5 before insert on public.social_media_jobs for each row execute function public.social_promotion_account_cap_v5();

create or replace function public.social_promotion_poll_v5(p_skip jsonb default '[]'::jsonb)
returns jsonb language sql stable security invoker set search_path='' as $$
with clock as (
  select now() as stamp, (now() at time zone 'Asia/Phnom_Penh')::date as local_day
), skip as (
  select x->>'ruleId' as rule_id, x->>'slot' as slot
  from jsonb_array_elements(case when jsonb_typeof(p_skip)='array' then p_skip else '[]'::jsonb end) x
  limit 200
), due as (
  select r.id,r.connection_id,((d.day+t.slot_time) at time zone 'Asia/Phnom_Penh') as slot,to_jsonb(r) as rule,r.daily_limit
  from public.social_promotion_rules r join public.social_media_connections c on c.id=r.connection_id
  cross join clock x
  cross join lateral (values (x.local_day),(x.local_day-1)) d(day)
  cross join lateral unnest(r.publish_times) t(slot_time)
  where r.owner_type='admin' and r.owner_id='shadow' and r.enabled and r.content_mode='short'
  and c.owner_type='admin' and c.owner_id='shadow' and c.platform in ('facebook','instagram') and c.status='connected'
  and c.token_ciphertext is not null and (c.token_expires_at is null or c.token_expires_at>x.stamp)
  and ((d.day+t.slot_time) at time zone 'Asia/Phnom_Penh') between x.stamp-interval '15 minutes' and x.stamp
), available as (
  select d.* from due d
  where not exists(select 1 from skip s where s.rule_id=d.id::text and s.slot=to_char(d.slot at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  and not exists(select 1 from public.social_media_jobs j where j.rule_id=d.id and j.scheduled_at=d.slot and j.rule_revision is not null)
  and (select count(*) from public.social_media_jobs j where j.connection_id=d.connection_id and j.owner_type='admin' and j.owner_id='shadow' and j.scheduled_at>=date_trunc('day',d.slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh' and j.scheduled_at<(date_trunc('day',d.slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh')+interval '24 hours')<3
  and (select count(*) from public.social_media_jobs j where j.rule_id=d.id and j.scheduled_at>=date_trunc('day',d.slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh' and j.scheduled_at<(date_trunc('day',d.slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh')+interval '24 hours')<d.daily_limit
  order by d.slot,d.id limit 12
)
select jsonb_build_object('due',coalesce((select jsonb_agg(jsonb_build_object('rule',rule,'slot',slot) order by slot,id) from available),'[]'::jsonb),
 'hasWork',exists(select 1 from public.social_media_jobs where owner_type='admin' and owner_id='shadow' and rule_revision is not null and ((status='queued' and scheduled_at<=now()) or (status='publishing' and coalesce(started_at,created_at)<now()-interval '15 minutes'))));
$$;
revoke all on function public.social_promotion_account_cap_v5(),public.social_promotion_poll_v5(jsonb) from public,anon,authenticated;
grant execute on function public.social_promotion_poll_v5(jsonb) to service_role;
commit;
