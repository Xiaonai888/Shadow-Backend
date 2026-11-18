begin;

create table if not exists public.admin_story_reader_daily (
  activity_day date not null,
  story_id uuid not null,
  user_id uuid not null,
  episode_reads integer not null check (episode_reads >= 0),
  last_read_at timestamptz not null,
  primary key (activity_day, story_id, user_id)
);

create index if not exists admin_story_reader_daily_story_day_idx
  on public.admin_story_reader_daily (story_id, activity_day, user_id)
  include (episode_reads);

create table if not exists public.admin_story_reader_snapshot_days (
  activity_day date primary key,
  completed_at timestamptz not null default now(),
  quality text not null default 'final' check (quality in ('final', 'backfill'))
);

alter table public.admin_story_reader_snapshot_days
  add column if not exists quality text not null default 'final';

alter table public.admin_story_reader_daily enable row level security;
alter table public.admin_story_reader_snapshot_days enable row level security;
revoke all on public.admin_story_reader_daily from public, anon, authenticated;
revoke all on public.admin_story_reader_snapshot_days from public, anon, authenticated;
grant select, insert, update, delete on public.admin_story_reader_daily to service_role;
grant select, insert, update, delete on public.admin_story_reader_snapshot_days to service_role;

create or replace function public.admin_story_read_signals_v1(
  p_from timestamptz,
  p_to timestamptz,
  p_story_id uuid default null
)
returns table (activity_at timestamptz, story_id uuid, user_id uuid, episode_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.occurred_at, ep.story_id, e.user_id, e.subject_id
  from public.reader_activity_events e
  join public.episodes ep on ep.id::text = e.subject_id
  where e.category = 'reading' and e.action = 'read' and e.subject_type = 'episode'
    and e.occurred_at >= p_from and e.occurred_at < p_to
    and (p_story_id is null or ep.story_id = p_story_id)

  union all

  select rp.last_read_at, rp.story_id, rp.user_id, rp.episode_id::text
  from public.reading_progress rp
  where rp.last_read_at >= p_from and rp.last_read_at < p_to
    and (p_story_id is null or rp.story_id = p_story_id)

  union all

  select t.event_time, v.story_id, v.user_id, v.episode_id::text
  from public.episode_view_logs v
  cross join lateral (values (v.created_at), (v.last_counted_at), (v.last_fast_counted_at)) t(event_time)
  where (p_story_id is null or v.story_id = p_story_id)
    and (
      (v.created_at >= p_from and v.created_at < p_to)
      or (v.last_counted_at >= p_from and v.last_counted_at < p_to)
      or (v.last_fast_counted_at >= p_from and v.last_fast_counted_at < p_to)
    )
    and t.event_time >= p_from and t.event_time < p_to
    and v.user_id is not null
$$;

create or replace function public.refresh_admin_story_reader_daily_v1(p_day date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  kh_today date := (clock_timestamp() at time zone 'Asia/Phnom_Penh')::date;
  target_day date := coalesce(p_day, (clock_timestamp() at time zone 'Asia/Phnom_Penh')::date - 1);
  start_at timestamptz;
  end_at timestamptz;
  saved bigint := 0;
begin
  if target_day >= kh_today or target_day < kh_today - 5 then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'DAY_OUT_OF_RANGE');
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(712553921) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'ROLLUP_BUSY');
  end if;

  if target_day < kh_today - 1 and exists (
    select 1 from public.admin_story_reader_snapshot_days d where d.activity_day = target_day
  ) then
    return pg_catalog.jsonb_build_object('ok', true, 'day', target_day, 'skipped', true);
  end if;

  start_at := target_day::timestamp at time zone 'Asia/Phnom_Penh';
  end_at := (target_day + 1)::timestamp at time zone 'Asia/Phnom_Penh';

  delete from public.admin_story_reader_daily where activity_day = target_day;

  insert into public.admin_story_reader_daily (activity_day, story_id, user_id, episode_reads, last_read_at)
  select target_day, e.story_id, e.user_id,
    pg_catalog.count(distinct e.episode_id)::integer,
    pg_catalog.max(e.activity_at)
  from public.admin_story_read_signals_v1(start_at, end_at, null) e
  where e.story_id is not null and e.user_id is not null and e.episode_id is not null
  group by e.story_id, e.user_id;

  get diagnostics saved = row_count;

  insert into public.admin_story_reader_snapshot_days(activity_day, completed_at, quality)
  values (
    target_day, clock_timestamp(),
    case when target_day = kh_today - 1 then 'final' else 'backfill' end
  )
  on conflict (activity_day) do update set
    completed_at = excluded.completed_at,
    quality = excluded.quality;

  delete from public.admin_story_reader_daily where activity_day < kh_today - 400;
  delete from public.admin_story_reader_snapshot_days where activity_day < kh_today - 400;

  return pg_catalog.jsonb_build_object('ok', true, 'day', target_day, 'reader_story_rows', saved);
end;
$$;

create or replace function public.get_admin_story_analytics_search_v1(
  p_query text default '', p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  needle text := pg_catalog.left(pg_catalog.btrim(coalesce(p_query, '')), 100);
  result jsonb;
begin
  if pg_catalog.char_length(needle) < 2 then
    return pg_catalog.jsonb_build_object('ok', true, 'items', '[]'::jsonb);
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', rows.id, 'title', rows.title, 'cover_url', rows.cover_url,
    'story_type', rows.story_type
  ) order by rows.rank, rows.title, rows.id), '[]'::jsonb)
  into result
  from (
    select s.id, s.title, s.cover_url, s.story_type,
      case when pg_catalog.lower(s.title) = pg_catalog.lower(needle) then 0 else 1 end as rank
    from public.stories s
    where s.deleted_at is null
      and (pg_catalog.strpos(pg_catalog.lower(coalesce(s.title, '')), pg_catalog.lower(needle)) > 0
        or s.id::text = needle)
    order by rank, s.title, s.id
    limit least(greatest(coalesce(p_limit, 10), 1), 12)
  ) rows;

  return pg_catalog.jsonb_build_object('ok', true, 'items', result);
end;
$$;

create or replace function public.get_admin_story_analytics_v1(
  p_story_id uuid,
  p_period text default 'week'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  kh_today date := (now() at time zone 'Asia/Phnom_Penh')::date;
  from_day date;
  to_day date;
  prev_from date;
  prev_to date;
  prev_complete boolean := false;
  period_complete boolean := false;
  coverage_start date;
  info jsonb;
  points jsonb := '[]'::jsonb;
  total_readers bigint := 0;
  total_reads bigint := 0;
  prev_readers bigint;
  previous_info jsonb := 'null'::jsonb;
  now_kh timestamptz := now();
begin
  if p_period not in ('today', 'yesterday', 'week', 'month', 'year') then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_PERIOD');
  end if;

  select pg_catalog.jsonb_build_object('id', s.id, 'title', s.title,
    'cover_url', s.cover_url, 'story_type', s.story_type)
  into info
  from public.stories s
  where s.id = p_story_id and s.deleted_at is null;

  if info is null then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'STORY_NOT_FOUND');
  end if;

  from_day := case p_period
    when 'today' then kh_today
    when 'yesterday' then kh_today - 1
    when 'week' then pg_catalog.date_trunc('week', kh_today::timestamp)::date
    when 'month' then pg_catalog.date_trunc('month', kh_today::timestamp)::date
    else pg_catalog.date_trunc('year', kh_today::timestamp)::date
  end;
  to_day := case when p_period = 'yesterday' then kh_today - 1 else kh_today end;
  prev_to := from_day - 1;
  prev_from := prev_to - (to_day - from_day);

  select pg_catalog.min(d.activity_day) into coverage_start
  from public.admin_story_reader_snapshot_days d;

  select not exists (
    select 1 from pg_catalog.generate_series(from_day::timestamp, least(to_day, kh_today - 1)::timestamp, interval '1 day') g(day)
    where not exists (
      select 1 from public.admin_story_reader_snapshot_days d
      where d.activity_day = g.day::date and d.quality = 'final'
    )
  ) into period_complete;

  if p_period = 'today' then
    with events as (
      select e.user_id, e.episode_id, pg_catalog.max(e.activity_at) as activity_at
      from public.admin_story_read_signals_v1(
        kh_today::timestamp at time zone 'Asia/Phnom_Penh', now_kh, p_story_id
      ) e
      where e.user_id is not null and e.episode_id is not null
      group by e.user_id, e.episode_id
    ), bars as (
      select pg_catalog.to_char(activity_at at time zone 'Asia/Phnom_Penh', 'HH24') as bucket,
        pg_catalog.count(distinct user_id) as readers,
        pg_catalog.count(*) as reads
      from events
      group by 1
    )
    select (select pg_catalog.count(distinct user_id) from events),
      (select pg_catalog.count(*) from events),
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'key', b.bucket, 'readers', b.readers, 'episode_reads', b.reads
      ) order by b.bucket), '[]'::jsonb) from bars b)
    into total_readers, total_reads, points;
  else
    with history as (
      select d.activity_day, d.user_id, d.episode_reads
      from public.admin_story_reader_daily d
      where d.story_id = p_story_id and d.activity_day between from_day and least(to_day, kh_today - 1)
    ), provisional as (
      select (e.activity_at at time zone 'Asia/Phnom_Penh')::date as activity_day,
        e.user_id, pg_catalog.count(distinct e.episode_id)::integer as episode_reads
      from public.admin_story_read_signals_v1(
        greatest(from_day, kh_today - 5)::timestamp at time zone 'Asia/Phnom_Penh',
        kh_today::timestamp at time zone 'Asia/Phnom_Penh', p_story_id
      ) e
      where e.user_id is not null and e.episode_id is not null
        and not exists (
          select 1 from public.admin_story_reader_snapshot_days s
          where s.activity_day = (e.activity_at at time zone 'Asia/Phnom_Penh')::date
        )
      group by 1, e.user_id
    ), live as (
      select kh_today as activity_day, e.user_id,
        pg_catalog.count(distinct e.episode_id)::integer as episode_reads
      from public.admin_story_read_signals_v1(
        kh_today::timestamp at time zone 'Asia/Phnom_Penh', now_kh, p_story_id
      ) e
      where p_period <> 'yesterday' and e.user_id is not null and e.episode_id is not null
      group by e.user_id
    ), combined as (
      select * from history
      union all
      select * from provisional
      union all
      select * from live
    ), bars as (
      select case when p_period = 'year'
        then pg_catalog.to_char(activity_day, 'YYYY-MM')
        else pg_catalog.to_char(activity_day, 'YYYY-MM-DD') end as bucket,
        pg_catalog.count(distinct user_id) as readers,
        pg_catalog.sum(episode_reads) as reads
      from combined
      group by 1
    )
    select (select pg_catalog.count(distinct user_id) from combined),
      (select coalesce(pg_catalog.sum(episode_reads), 0) from combined),
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'key', b.bucket, 'readers', b.readers, 'episode_reads', b.reads
      ) order by b.bucket), '[]'::jsonb) from bars b)
    into total_readers, total_reads, points;
  end if;

  select not exists (
    select 1 from pg_catalog.generate_series(prev_from::timestamp, prev_to::timestamp, interval '1 day') g(day)
    where not exists (
      select 1 from public.admin_story_reader_snapshot_days d
      where d.activity_day = g.day::date and d.quality = 'final'
    )
  ) into prev_complete;

  if prev_complete then
    select pg_catalog.count(distinct d.user_id) into prev_readers
    from public.admin_story_reader_daily d
    where d.story_id = p_story_id and d.activity_day between prev_from and prev_to;

    previous_info := pg_catalog.jsonb_build_object(
      'from', prev_from, 'to', prev_to, 'readers', prev_readers,
      'change_percent', case when prev_readers > 0 then
        pg_catalog.round((total_readers - prev_readers)::numeric * 100 / prev_readers, 1)
      else null end
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'story', info,
    'period', p_period,
    'date_from', from_day,
    'date_to', to_day,
    'timezone', 'Asia/Phnom_Penh',
    'tracking_since', coverage_start,
    'history_complete', period_complete and (from_day >= coalesce(coverage_start, kh_today)),
    'snapshot_complete', p_period = 'yesterday' and period_complete,
    'unique_readers', coalesce(total_readers, 0),
    'episode_reads', coalesce(total_reads, 0),
    'previous', previous_info,
    'buckets', points,
    'generated_at', now_kh
  );
end;
$$;

revoke all on function public.admin_story_read_signals_v1(timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.refresh_admin_story_reader_daily_v1(date) from public, anon, authenticated;
revoke all on function public.get_admin_story_analytics_search_v1(text, integer) from public, anon, authenticated;
revoke all on function public.get_admin_story_analytics_v1(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_story_read_signals_v1(timestamptz, timestamptz, uuid) to service_role;
grant execute on function public.refresh_admin_story_reader_daily_v1(date) to service_role;
grant execute on function public.get_admin_story_analytics_search_v1(text, integer) to service_role;
grant execute on function public.get_admin_story_analytics_v1(uuid, text) to service_role;

commit;

do $$
declare
  n integer;
begin
  for n in 1..5 loop
    perform public.refresh_admin_story_reader_daily_v1(
      (clock_timestamp() at time zone 'Asia/Phnom_Penh')::date - n
    );
  end loop;
end;
$$;

do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'admin_story_reader_daily_v1',
      '20 18 * * *',
      'select public.refresh_admin_story_reader_daily_v1()'
    );
  end if;
end;
$$;
