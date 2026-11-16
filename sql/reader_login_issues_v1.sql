create table if not exists public.reader_login_issue_events (
  id bigint generated always as identity primary key,
  observed_at timestamptz not null default now(),
  user_id text,
  error_code varchar(64) not null check (error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  issue_source varchar(16) not null check (issue_source in ('LOGIN', 'VERIFY', 'SESSION'))
);

create index if not exists reader_login_issues_time_idx
  on public.reader_login_issue_events (observed_at desc);

create index if not exists reader_login_issues_code_time_idx
  on public.reader_login_issue_events (error_code, observed_at desc);

alter table public.reader_login_issue_events enable row level security;
revoke all on public.reader_login_issue_events from public, anon, authenticated;
grant select, insert, delete on public.reader_login_issue_events to service_role;

create or replace function public.get_reader_login_issues(p_hours integer default 24)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with period as (
  select case when p_hours = 168 then 168 else 24 end as hours
),
recent as materialized (
  select e.user_id, e.error_code, e.issue_source, e.observed_at
  from public.reader_login_issue_events e, period p
  where e.observed_at >= now() - make_interval(hours => p.hours)
),
groups as (
  select r.error_code,
         count(*) as observations,
         count(distinct r.user_id) as affected_users,
         count(distinct r.user_id) filter (where r.observed_at >= now() - interval '24 hours') as affected_users_last_24h,
         count(*) filter (where r.user_id is null) as unidentified_observations,
         string_agg(distinct r.issue_source, ', ' order by r.issue_source) as sources,
         max(r.observed_at) as last_seen
  from recent r
  group by r.error_code
)
select jsonb_build_object(
  'available', true,
  'hours', (select hours from period),
  'generated_at', now(),
  'observations', (select count(*) from recent),
  'affected_users', (select count(distinct user_id) from recent),
  'issues', coalesce((
    select jsonb_agg(jsonb_build_object(
      'error_code', g.error_code,
      'sources', g.sources,
      'observations', g.observations,
      'affected_users', g.affected_users,
      'affected_users_last_24h', g.affected_users_last_24h,
      'unidentified_observations', g.unidentified_observations,
      'last_seen', g.last_seen,
      'classification', case when g.affected_users_last_24h > 10 then 'COMMON' when g.affected_users > 10 then 'HISTORICAL' else 'INDIVIDUAL' end,
      'users', case when g.affected_users > 10 then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object(
          'user_id', recent_users.user_id,
          'username', coalesce(u.username, 'Unknown'),
          'last_seen', recent_users.last_seen
        ) order by recent_users.last_seen desc)
        from (
          select r.user_id, max(r.observed_at) as last_seen
          from recent r
          where r.error_code = g.error_code and r.user_id is not null
          group by r.user_id
          order by max(r.observed_at) desc
          limit 10
        ) recent_users
        left join public.users u on u.id::text = recent_users.user_id
      ), '[]'::jsonb) end
    ) order by g.affected_users desc, g.last_seen desc)
    from (
      select * from groups
      order by affected_users desc, last_seen desc
      limit 30
    ) g
  ), '[]'::jsonb)
);
$$;

create or replace function public.prune_reader_login_issues()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.reader_login_issue_events
  where observed_at < now() - interval '14 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.get_reader_login_issues(integer) from public, anon, authenticated;
revoke all on function public.prune_reader_login_issues() from public, anon, authenticated;
grant execute on function public.get_reader_login_issues(integer) to service_role;
grant execute on function public.prune_reader_login_issues() to service_role;
