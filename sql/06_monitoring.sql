begin;

create table if not exists public.telegram_promotion_worker_health (
  language text primary key references public.telegram_promotion_settings(language),
  instance_id uuid not null,
  last_seen_at timestamptz not null,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text check (last_error is null or length(last_error)<=300),
  last_ok boolean not null
);

create table if not exists public.telegram_promotion_watchdog_history (
  language text not null references public.telegram_promotion_settings(language),
  checkpoint_at timestamptz not null,
  checked_at timestamptz not null default now(),
  window_from timestamptz not null,
  worker_state text not null check (worker_state in ('healthy','starting','stale','error')),
  last_seen_at timestamptz,
  last_success_at timestamptz,
  recovery_completed_through timestamptz,
  published_candidates bigint not null,
  missing_events bigint not null,
  pending_events bigint not null,
  ready_posts bigint not null,
  sending_posts bigint not null,
  sent_updates bigint not null,
  failed_posts bigint not null,
  uncertain_posts bigint not null,
  primary key(language,checkpoint_at)
);
create index if not exists telegram_promotion_watchdog_history_time_idx on public.telegram_promotion_watchdog_history(checkpoint_at desc);
alter table public.telegram_promotion_worker_health enable row level security;
alter table public.telegram_promotion_watchdog_history enable row level security;
revoke all on public.telegram_promotion_worker_health,public.telegram_promotion_watchdog_history from public,anon,authenticated;
grant select,insert,update,delete on public.telegram_promotion_worker_health,public.telegram_promotion_watchdog_history to service_role;

create or replace function public.telegram_promotion_heartbeat_v1(p_language text,p_instance_id uuid,p_ok boolean,p_error text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_instance_id is null or p_ok is null or not exists(select 1 from public.telegram_promotion_settings where language=p_language and enabled) then return false; end if;
  insert into public.telegram_promotion_worker_health(language,instance_id,last_seen_at,last_success_at,last_failure_at,last_error,last_ok)
  values(p_language,p_instance_id,clock_timestamp(),case when p_ok then clock_timestamp() end,case when not p_ok then clock_timestamp() end,case when not p_ok then left(p_error,300) end,p_ok)
  on conflict(language) do update set
    instance_id=excluded.instance_id,last_seen_at=excluded.last_seen_at,last_ok=excluded.last_ok,
    last_success_at=coalesce(excluded.last_success_at,telegram_promotion_worker_health.last_success_at),
    last_failure_at=coalesce(excluded.last_failure_at,telegram_promotion_worker_health.last_failure_at),last_error=excluded.last_error;
  return true;
end;
$$;

create or replace function public.telegram_promotion_watchdog_v1()
returns integer language plpgsql security invoker set search_path='' as $$
declare
  v_now timestamptz:=clock_timestamp();
  v_local timestamp:=v_now at time zone 'Asia/Phnom_Penh';
  v_checkpoint timestamptz;
  v_count integer;
begin
  v_checkpoint:=(date_trunc('day',v_local)+case
    when v_local::time>=time '18:00' then interval '18 hours'
    when v_local::time>=time '11:00' then interval '11 hours'
    when v_local::time>=time '07:00' then interval '7 hours'
    else interval '-6 hours' end) at time zone 'Asia/Phnom_Penh';
  if not pg_try_advisory_xact_lock(120782,7) then return 0; end if;
  with scope as materialized (
    select s.language,s.enabled_at,h.last_seen_at,h.last_success_at,h.last_ok,r.completed_through,
      greatest(date_trunc('day',s.enabled_at at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh',v_now-interval '24 hours') as window_from
    from public.telegram_promotion_settings s
    left join public.telegram_promotion_worker_health h on h.language=s.language
    left join public.telegram_promotion_recovery r on r.language=s.language
    where s.enabled and s.enabled_at<=v_now
      and not exists(select 1 from public.telegram_promotion_watchdog_history w where w.language=s.language and w.checkpoint_at=v_checkpoint)
  ), source_counts as (
    select x.language,count(*) as published_candidates,count(*) filter(where ev.episode_id is null and q.id is null) as missing_events
    from scope x join public.episodes e on e.first_published_at>=x.window_from and e.first_published_at<=v_now
    join public.stories s on s.id=e.story_id
    join public.shadow_reader_visible_stories_v1 v on v.id=s.id
    join public.author_pages a on a.id=s.author_id and a.status='active'
    left join public.telegram_promotion_events ev on ev.language=x.language and ev.episode_id=e.id
    left join public.telegram_promotion_queue q on q.language=x.language and q.episode_id=e.id and q.kind='update'
    where public.telegram_promotion_language_v1(s.story_language)=x.language
      and s.status='published' and e.status='published' and s.deleted_at is null and e.deleted_at is null
      and coalesce(s.admin_visibility_status,'active') in ('','active')
      and s.is_adult is not true and e.is_adult is not true
      and (s.is_shadow_exclusive is not true or s.exclusive_status='approved')
      and coalesce(s.ranking_visibility_status,'visible')='visible' and coalesce(a.ranking_visibility_status,'visible')='visible'
      and nullif(trim(s.cover_url),'') is not null
      and greatest(e.first_published_at,e.published_at,e.scheduled_at)<=v_now
    group by x.language
  ), event_counts as (
    select e.language,count(*) as pending_events from public.telegram_promotion_events e join scope x on x.language=e.language
    where e.state='pending' and e.due_at<=v_now group by e.language
  ), queue_counts as (
    select q.language,
      count(*) filter(where q.status='ready' and q.due_at<=v_now and (q.expires_at is null or q.expires_at>v_now)) as ready_posts,
      count(*) filter(where q.status='sending') as sending_posts,
      count(*) filter(where q.kind='update' and q.status='sent' and q.sent_at>=x.window_from) as sent_updates,
      count(*) filter(where q.status='failed' and q.updated_at>=x.window_from) as failed_posts,
      count(*) filter(where q.status='uncertain') as uncertain_posts
    from public.telegram_promotion_queue q join scope x on x.language=q.language
    where q.status in ('ready','sending','uncertain') or q.updated_at>=x.window_from
    group by q.language
  )
  insert into public.telegram_promotion_watchdog_history(language,checkpoint_at,checked_at,window_from,worker_state,last_seen_at,last_success_at,recovery_completed_through,published_candidates,missing_events,pending_events,ready_posts,sending_posts,sent_updates,failed_posts,uncertain_posts)
  select x.language,v_checkpoint,v_now,x.window_from,
    case when x.last_seen_at is null or x.last_seen_at<x.enabled_at then case when x.enabled_at>v_now-interval '30 minutes' then 'starting' else 'stale' end
      when x.last_seen_at<v_now-interval '30 minutes' then 'stale'
      when x.last_ok is false then 'error' else 'healthy' end,
    x.last_seen_at,x.last_success_at,x.completed_through,coalesce(c.published_candidates,0),coalesce(c.missing_events,0),coalesce(e.pending_events,0),coalesce(q.ready_posts,0),coalesce(q.sending_posts,0),coalesce(q.sent_updates,0),coalesce(q.failed_posts,0),coalesce(q.uncertain_posts,0)
  from scope x left join source_counts c on c.language=x.language left join event_counts e on e.language=x.language left join queue_counts q on q.language=x.language
  on conflict(language,checkpoint_at) do nothing;
  get diagnostics v_count=row_count;
  delete from public.telegram_promotion_watchdog_history where checkpoint_at<v_now-interval '30 days';
  return v_count;
end;
$$;

create or replace function public.telegram_promotion_monitor_status_v1()
returns jsonb language sql stable security invoker set search_path='' as $$
select coalesce(jsonb_agg(jsonb_build_object(
 'language',s.language,'enabled',s.enabled,
 'worker_state',case when not s.enabled then 'disabled' when h.last_seen_at is null or h.last_seen_at<s.enabled_at then case when s.enabled_at>now()-interval '30 minutes' then 'starting' else 'stale' end when h.last_seen_at<now()-interval '30 minutes' then 'stale' when h.last_ok is false then 'error' else 'healthy' end,
 'last_seen_at',h.last_seen_at,'last_success_at',h.last_success_at,'last_failure_at',h.last_failure_at,'last_error',h.last_error,
 'recovery_completed_through',r.completed_through,'last_checkpoint',to_jsonb(w)
) order by s.language),'[]'::jsonb)
from public.telegram_promotion_settings s
left join public.telegram_promotion_worker_health h on h.language=s.language
left join public.telegram_promotion_recovery r on r.language=s.language
left join lateral(select * from public.telegram_promotion_watchdog_history w where w.language=s.language order by w.checkpoint_at desc limit 1) w on true;
$$;

revoke all on function public.telegram_promotion_heartbeat_v1(text,uuid,boolean,text),public.telegram_promotion_watchdog_v1(),public.telegram_promotion_monitor_status_v1() from public,anon,authenticated;
grant execute on function public.telegram_promotion_heartbeat_v1(text,uuid,boolean,text),public.telegram_promotion_watchdog_v1(),public.telegram_promotion_monitor_status_v1() to service_role;
commit;
