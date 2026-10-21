begin;

create index if not exists reader_activity_summaries_period_last_idx
on public.reader_activity_summaries (period, last_at, id);

create or replace function public.rollup_reader_activity_summaries(p_max_batches integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  week_cutoff timestamptz := (
    ((clock_timestamp() at time zone 'Asia/Phnom_Penh')::date - 30)::timestamp
    at time zone 'Asia/Phnom_Penh'
  );
  month_cutoff timestamptz := (
    ((clock_timestamp() at time zone 'Asia/Phnom_Penh')::date - 90)::timestamp
    at time zone 'Asia/Phnom_Penh'
  );
  retention_cutoff timestamptz := clock_timestamp() - interval '365 days';
  max_batches integer := least(greatest(coalesce(p_max_batches, 25), 1), 100);
  moved_rows bigint := 0;
  written_rows bigint := 0;
  week_rows bigint := 0;
  month_rows bigint := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(712553801) then
    return pg_catalog.jsonb_build_object('ok', true, 'skipped', true);
  end if;

  for batch_index in 1..max_batches loop
    with chosen as (
      select id, user_id, category, action, event_count, first_at, last_at
      from public.reader_activity_summaries
      where period = 'day'
        and last_at < week_cutoff
        and last_at >= retention_cutoff
      order by last_at, id
      limit 1000
      for update skip locked
    ), buckets as (
      select user_id, 'week'::text as period,
        pg_catalog.date_trunc('week', first_at at time zone 'Asia/Phnom_Penh')
          at time zone 'Asia/Phnom_Penh' as period_start,
        category, action, sum(event_count)::integer as event_count,
        min(first_at) as first_at, max(last_at) as last_at
      from chosen
      group by user_id, period_start, category, action
    ), stored as (
      insert into public.reader_activity_summaries (
        user_id, period, period_start, category, action,
        event_count, first_at, last_at, updated_at
      )
      select user_id, period, period_start, category, action,
        event_count, first_at, last_at, clock_timestamp()
      from buckets
      on conflict on constraint reader_activity_summary_group_unique
      do update set
        event_count = public.reader_activity_summaries.event_count + excluded.event_count,
        first_at = least(public.reader_activity_summaries.first_at, excluded.first_at),
        last_at = greatest(public.reader_activity_summaries.last_at, excluded.last_at),
        updated_at = clock_timestamp()
      returning id
    ), removed as (
      delete from public.reader_activity_summaries s
      using chosen c
      where s.id = c.id
        and exists (select 1 from stored)
      returning s.id
    )
    select (select count(*) from removed), (select count(*) from stored)
    into moved_rows, written_rows;

    week_rows := week_rows + moved_rows;
    exit when moved_rows < 1000;
  end loop;

  for batch_index in 1..max_batches loop
    with chosen as (
      select id, user_id, category, action, event_count, first_at, last_at
      from public.reader_activity_summaries
      where period = 'week'
        and last_at < month_cutoff
        and last_at >= retention_cutoff
      order by last_at, id
      limit 1000
      for update skip locked
    ), buckets as (
      select user_id, 'month'::text as period,
        pg_catalog.date_trunc('month', first_at at time zone 'Asia/Phnom_Penh')
          at time zone 'Asia/Phnom_Penh' as period_start,
        category, action, sum(event_count)::integer as event_count,
        min(first_at) as first_at, max(last_at) as last_at
      from chosen
      group by user_id, period_start, category, action
    ), stored as (
      insert into public.reader_activity_summaries (
        user_id, period, period_start, category, action,
        event_count, first_at, last_at, updated_at
      )
      select user_id, period, period_start, category, action,
        event_count, first_at, last_at, clock_timestamp()
      from buckets
      on conflict on constraint reader_activity_summary_group_unique
      do update set
        event_count = public.reader_activity_summaries.event_count + excluded.event_count,
        first_at = least(public.reader_activity_summaries.first_at, excluded.first_at),
        last_at = greatest(public.reader_activity_summaries.last_at, excluded.last_at),
        updated_at = clock_timestamp()
      returning id
    ), removed as (
      delete from public.reader_activity_summaries s
      using chosen c
      where s.id = c.id
        and exists (select 1 from stored)
      returning s.id
    )
    select (select count(*) from removed), (select count(*) from stored)
    into moved_rows, written_rows;

    month_rows := month_rows + moved_rows;
    exit when moved_rows < 1000;
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'day_rows_rolled_to_week', week_rows,
    'week_rows_rolled_to_month', month_rows
  );
end;
$$;

revoke all on function public.rollup_reader_activity_summaries(integer)
from public, anon, authenticated;

grant execute on function public.rollup_reader_activity_summaries(integer)
to service_role;

commit;

do $$
declare
  job_id bigint;
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    begin
      select cron.schedule(
        'reader_activity_rollup_week_month_v1',
        '50 18 * * *',
        'select public.rollup_reader_activity_summaries(25)'
      ) into job_id;
      raise notice 'Reader activity rollup scheduled, job id: %', job_id;
    exception when others then
      raise notice 'Reader activity rollup scheduling unavailable: %', sqlerrm;
    end;
  else
    raise notice 'pg_cron is not enabled; rollup function installed without automatic scheduling';
  end if;
end;
$$;
