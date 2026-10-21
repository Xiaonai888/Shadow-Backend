begin;

create index if not exists reader_activity_summaries_last_at_idx
on public.reader_activity_summaries (last_at);

create or replace function public.maintain_reader_activity_history(p_max_batches integer default 40)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  detail_cutoff timestamptz := (
    ((clock_timestamp() at time zone 'Asia/Phnom_Penh')::date - 6)::timestamp
    at time zone 'Asia/Phnom_Penh'
  );
  retention_cutoff timestamptz := clock_timestamp() - interval '365 days';
  batch_count bigint := 0;
  written_count bigint := 0;
  events_compacted bigint := 0;
  summaries_written bigint := 0;
  events_expired bigint := 0;
  summaries_expired bigint := 0;
  max_batches integer := least(greatest(coalesce(p_max_batches, 40), 1), 100);
begin
  if not pg_catalog.pg_try_advisory_xact_lock(712553801) then
    return pg_catalog.jsonb_build_object('ok', true, 'skipped', true);
  end if;

  for batch_index in 1..max_batches loop
    with chosen as (
      select id
      from public.reader_activity_events
      where occurred_at < retention_cutoff
      order by occurred_at, id
      limit 1000
      for update skip locked
    ), removed as (
      delete from public.reader_activity_events e
      using chosen c
      where e.id = c.id
      returning e.id
    )
    select count(*) into batch_count from removed;

    events_expired := events_expired + batch_count;
    exit when batch_count < 1000;
  end loop;

  for batch_index in 1..max_batches loop
    with chosen as (
      select id
      from public.reader_activity_events
      where category <> 'security'
        and occurred_at >= retention_cutoff
        and occurred_at < detail_cutoff
      order by occurred_at, id
      limit 1000
      for update skip locked
    ), moved as (
      delete from public.reader_activity_events e
      using chosen c
      where e.id = c.id
      returning e.user_id, e.category, e.action, e.occurred_at
    ), daily_buckets as (
      select
        user_id,
        'day'::text as period,
        pg_catalog.date_trunc('day', occurred_at at time zone 'Asia/Phnom_Penh')
          at time zone 'Asia/Phnom_Penh' as period_start,
        category,
        action,
        count(*)::integer as event_count,
        min(occurred_at) as first_at,
        max(occurred_at) as last_at
      from moved
      group by user_id, period_start, category, action
    ), stored as (
      insert into public.reader_activity_summaries (
        user_id, period, period_start, category, action,
        event_count, first_at, last_at, updated_at
      )
      select user_id, period, period_start, category, action,
        event_count, first_at, last_at, clock_timestamp()
      from daily_buckets
      on conflict on constraint reader_activity_summary_group_unique
      do update set
        event_count = public.reader_activity_summaries.event_count + excluded.event_count,
        first_at = least(public.reader_activity_summaries.first_at, excluded.first_at),
        last_at = greatest(public.reader_activity_summaries.last_at, excluded.last_at),
        updated_at = clock_timestamp()
      returning id
    )
    select
      (select count(*) from moved),
      (select count(*) from stored)
    into batch_count, written_count;

    events_compacted := events_compacted + batch_count;
    summaries_written := summaries_written + written_count;
    exit when batch_count < 1000;
  end loop;

  for batch_index in 1..max_batches loop
    with chosen as (
      select id
      from public.reader_activity_summaries
      where last_at < retention_cutoff
      order by last_at, id
      limit 1000
      for update skip locked
    ), removed as (
      delete from public.reader_activity_summaries s
      using chosen c
      where s.id = c.id
      returning s.id
    )
    select count(*) into batch_count from removed;

    summaries_expired := summaries_expired + batch_count;
    exit when batch_count < 1000;
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'events_compacted', events_compacted,
    'summaries_written', summaries_written,
    'events_expired', events_expired,
    'summaries_expired', summaries_expired,
    'retention_days', 365
  );
end;
$$;

revoke all on function public.maintain_reader_activity_history(integer)
from public, anon, authenticated;

grant execute on function public.maintain_reader_activity_history(integer)
to service_role;

commit;

do $$
declare
  job_id bigint;
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    begin
      select cron.schedule(
        'reader_activity_history_daily_v1',
        '20 18 * * *',
        'select public.maintain_reader_activity_history(40)'
      ) into job_id;
      raise notice 'Reader Activity History scheduled, job id: %', job_id;
    exception when others then
      raise notice 'Reader Activity History scheduling unavailable: %', sqlerrm;
    end;
  else
    raise notice 'pg_cron is not enabled; daily function installed but scheduling must be configured separately';
  end if;
end;
$$;
