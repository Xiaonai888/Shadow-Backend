begin;

create table if not exists public.reader_reading_daily_summaries (
  user_id uuid not null references public.users(id) on delete cascade,
  day date not null,
  stories_read integer not null default 0 check (stories_read >= 0),
  episodes_read integer not null default 0 check (episodes_read >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists reader_reading_daily_summaries_day_idx
on public.reader_reading_daily_summaries (day);

create index if not exists reader_activity_events_read_day_idx
on public.reader_activity_events (occurred_at, user_id) include (subject_id)
where category = 'reading' and action = 'read';

alter table public.reader_reading_daily_summaries enable row level security;
revoke all on public.reader_reading_daily_summaries from public, anon, authenticated;
grant select, insert, update, delete on public.reader_reading_daily_summaries to service_role;

create or replace function public.refresh_reader_reading_daily_summary(p_day date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  today_kh date := (clock_timestamp() at time zone 'Asia/Phnom_Penh')::date;
  target_day date := coalesce(p_day, (clock_timestamp() at time zone 'Asia/Phnom_Penh')::date - 1);
  start_at timestamptz;
  end_at timestamptz;
  saved_count bigint := 0;
  removed_count bigint := 0;
begin
  if target_day >= today_kh or target_day < today_kh - 365 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'DATE_OUT_OF_RANGE');
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(712553805) then
    return pg_catalog.jsonb_build_object('ok', true, 'skipped', true);
  end if;

  start_at := target_day::timestamp at time zone 'Asia/Phnom_Penh';
  end_at := (target_day + 1)::timestamp at time zone 'Asia/Phnom_Penh';

  with daily_counts as (
    select
      event.user_id,
      count(distinct episode.story_id)::integer as stories_read,
      count(distinct event.subject_id)::integer as episodes_read
    from public.reader_activity_events event
    left join public.episodes episode on episode.id::text = event.subject_id
    where event.category = 'reading'
      and event.action = 'read'
      and event.subject_id is not null
      and event.occurred_at >= start_at
      and event.occurred_at < end_at
    group by event.user_id
  ), saved as (
    insert into public.reader_reading_daily_summaries (
      user_id, day, stories_read, episodes_read, updated_at
    )
    select user_id, target_day, stories_read, episodes_read, clock_timestamp()
    from daily_counts
    on conflict (user_id, day) do update set
      stories_read = excluded.stories_read,
      episodes_read = excluded.episodes_read,
      updated_at = excluded.updated_at
    returning user_id
  )
  select count(*) into saved_count from saved;

  delete from public.reader_reading_daily_summaries
  where day < today_kh - 365;
  get diagnostics removed_count = row_count;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'day', target_day,
    'users_updated', saved_count,
    'expired_days_removed', removed_count
  );
end;
$$;

revoke all on function public.refresh_reader_reading_daily_summary(date)
from public, anon, authenticated;
grant execute on function public.refresh_reader_reading_daily_summary(date)
to service_role;

commit;

do $$
declare
  day_offset integer;
begin
  for day_offset in 1..5 loop
    perform public.refresh_reader_reading_daily_summary(
      (clock_timestamp() at time zone 'Asia/Phnom_Penh')::date - day_offset
    );
  end loop;
end;
$$;

do $$
declare
  job_id bigint;
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    select cron.schedule(
      'reader_reading_daily_summary_v1',
      '5 18 * * *',
      'select public.refresh_reader_reading_daily_summary()'
    ) into job_id;
    raise notice 'Reader daily reading summary scheduled, job id: %', job_id;
  else
    raise notice 'pg_cron is not enabled; schedule the daily summary function separately';
  end if;
end;
$$;
