create table if not exists public.reader_health_events (
  report_id uuid not null,
  event_index smallint not null check (event_index between 0 and 5),
  observed_at timestamptz not null default now(),
  session_hash varchar(40) not null,
  sampled boolean not null,
  event_type varchar(30) not null check (event_type in (
    'session_seen', 'js_error', 'promise_rejection', 'script_load_failure',
    'long_task', 'event_loop_delay', 'slow_api', 'slow_boot'
  )),
  page_group varchar(20) not null,
  fingerprint varchar(24) not null default '',
  metric_ms integer not null default 0 check (metric_ms between 0 and 60000),
  browser varchar(15) not null,
  os varchar(15) not null,
  device varchar(15) not null,
  primary key (report_id, event_index)
);

create index if not exists reader_health_events_time_idx
  on public.reader_health_events (observed_at desc);

create index if not exists reader_health_events_group_time_idx
  on public.reader_health_events (event_type, observed_at desc);

alter table public.reader_health_events enable row level security;
revoke all on public.reader_health_events from public, anon, authenticated;
grant select, insert, delete on public.reader_health_events to service_role;

create or replace function public.get_reader_health_diagnostics(p_hours integer default 24)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with bounds as (
  select least(168, greatest(1, coalesce(p_hours, 24))) as hours
),
base as materialized (
  select e.*
  from public.reader_health_events e, bounds b
  where e.observed_at >= now() - make_interval(hours => b.hours)
),
totals as (
  select
    count(*) as event_count,
    count(distinct session_hash) filter (where event_type = 'session_seen') as sampled_sessions,
    count(distinct session_hash) filter (where event_type <> 'session_seen') as affected_sessions_observed,
    count(distinct session_hash) filter (where sampled and event_type <> 'session_seen') as affected_sampled_sessions,
    count(distinct session_hash) filter (where event_type in ('js_error', 'promise_rejection', 'script_load_failure')) as confirmed_error_sessions,
    count(distinct session_hash) filter (where event_type in ('long_task', 'event_loop_delay', 'slow_api', 'slow_boot')) as slowdown_signal_sessions,
    count(*) filter (where event_type in ('js_error', 'promise_rejection', 'script_load_failure')) as error_events,
    count(*) filter (where event_type = 'event_loop_delay') as suspected_freeze_events
  from base
),
category_rollup as (
  select event_type, count(*) as event_count,
    count(distinct session_hash) as affected_sessions,
    max(metric_ms) as max_metric_ms
  from base
  where event_type <> 'session_seen'
  group by event_type
  order by event_count desc
  limit 12
),
page_rollup as (
  select page_group, count(*) as event_count,
    count(distinct session_hash) as affected_sessions,
    count(*) filter (where event_type in ('js_error', 'promise_rejection', 'script_load_failure')) as error_events
  from base
  where event_type <> 'session_seen'
  group by page_group
  order by event_count desc
  limit 15
),
browser_rollup as (
  select browser, os, device, count(*) as event_count,
    count(distinct session_hash) as affected_sessions
  from base
  where event_type <> 'session_seen'
  group by browser, os, device
  order by event_count desc
  limit 15
),
signature_rollup as (
  select event_type, page_group, fingerprint, count(*) as event_count,
    count(distinct session_hash) as affected_sessions,
    max(metric_ms) as max_metric_ms,
    max(observed_at) as last_seen
  from base
  where event_type <> 'session_seen'
  group by event_type, page_group, fingerprint
  order by event_count desc
  limit 25
),
hourly_rollup as (
  select date_trunc('hour', observed_at) as hour,
    count(*) filter (where event_type <> 'session_seen') as event_count,
    count(distinct session_hash) filter (where event_type <> 'session_seen') as affected_sessions
  from base
  group by date_trunc('hour', observed_at)
  order by hour desc
  limit 168
)
select jsonb_build_object(
  'available', true,
  'schema_version', 1,
  'hours', (select hours from bounds),
  'generated_at', now(),
  'sample_rate', 0.1,
  'totals', (select to_jsonb(t) from totals t),
  'categories', coalesce((select jsonb_agg(to_jsonb(x) order by x.event_count desc) from category_rollup x), '[]'::jsonb),
  'pages', coalesce((select jsonb_agg(to_jsonb(x) order by x.event_count desc) from page_rollup x), '[]'::jsonb),
  'browsers', coalesce((select jsonb_agg(to_jsonb(x) order by x.event_count desc) from browser_rollup x), '[]'::jsonb),
  'signatures', coalesce((select jsonb_agg(to_jsonb(x) order by x.event_count desc) from signature_rollup x), '[]'::jsonb),
  'hourly', coalesce((select jsonb_agg(to_jsonb(x) order by x.hour desc) from hourly_rollup x), '[]'::jsonb)
);
$$;

create or replace function public.prune_reader_health_events()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.reader_health_events
  where observed_at < now() - interval '14 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.get_reader_health_diagnostics(integer) from public, anon, authenticated;
revoke all on function public.prune_reader_health_events() from public, anon, authenticated;
grant execute on function public.get_reader_health_diagnostics(integer) to service_role;
grant execute on function public.prune_reader_health_events() to service_role;
