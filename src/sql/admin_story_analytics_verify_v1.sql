select
  'admin_story_reader_daily' as object_name,
  pg_catalog.to_regclass('public.admin_story_reader_daily') is not null as ready
union all
select
  'admin_story_reader_snapshot_days',
  pg_catalog.to_regclass('public.admin_story_reader_snapshot_days') is not null
union all
select
  'admin_story_read_signals_v1',
  pg_catalog.to_regprocedure('public.admin_story_read_signals_v1(timestamptz,timestamptz,uuid)') is not null
union all
select
  'refresh_admin_story_reader_daily_v1',
  pg_catalog.to_regprocedure('public.refresh_admin_story_reader_daily_v1(date)') is not null
union all
select
  'get_admin_story_analytics_search_v1',
  pg_catalog.to_regprocedure('public.get_admin_story_analytics_search_v1(text,integer)') is not null
union all
select
  'get_admin_story_analytics_v1',
  pg_catalog.to_regprocedure('public.get_admin_story_analytics_v1(uuid,text)') is not null;

do $$
declare
  days_count bigint;
  reader_story_count bigint;
  earliest_day date;
  latest_day date;
  finals_count bigint;
  partial_count bigint;
begin
  if pg_catalog.to_regclass('public.admin_story_reader_daily') is null
    or pg_catalog.to_regclass('public.admin_story_reader_snapshot_days') is null then
    raise notice 'Story Analytics snapshot tables are not installed yet';
    return;
  end if;

  execute 'select count(*), min(activity_day), max(activity_day), count(*) filter (where quality = ''final''), count(*) filter (where quality = ''backfill'') from public.admin_story_reader_snapshot_days'
    into days_count, earliest_day, latest_day, finals_count, partial_count;
  select coalesce(c.reltuples::bigint, 0) into reader_story_count
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'admin_story_reader_daily';

  raise notice 'Snapshot days: %, from % to %, final: %, backfill: %', days_count, earliest_day, latest_day, finals_count, partial_count;
  raise notice 'Estimated story-reader-day rows: %', reader_story_count;
end;
$$;
