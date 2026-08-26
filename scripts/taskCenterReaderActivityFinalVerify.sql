with today as (
  select (now() at time zone 'Asia/Phnom_Penh')::date as activity_date
),
refresh_summary as (
  select public.task_center_refresh_daily_summary(activity_date)
  from today
),
checks as (
  select
    to_regclass('public.task_center_reader_daily_snapshots') is not null as snapshots_table_ok,
    to_regclass('public.task_center_daily_summaries') is not null as summaries_table_ok,
    to_regclass('public.task_center_activity_maintenance') is not null as maintenance_table_ok,
    to_regprocedure('public.task_center_refresh_reader_snapshot_stats(date,uuid)') is not null as snapshot_stats_function_ok,
    to_regprocedure('public.task_center_refresh_daily_summary(date)') is not null as summary_function_ok,
    to_regprocedure('public.task_center_run_activity_retention()') is not null as retention_function_ok,
    exists (
      select 1
      from pg_trigger
      where tgname = 'task_center_capture_checkin_activity_trigger'
        and not tgisinternal
    ) as checkin_trigger_ok,
    exists (
      select 1
      from pg_trigger
      where tgname = 'task_center_capture_reading_activity_trigger'
        and not tgisinternal
    ) as reading_trigger_ok,
    exists (
      select 1
      from pg_trigger
      where tgname = 'task_center_capture_mission_activity_trigger'
        and not tgisinternal
    ) as mission_trigger_ok
),
summary as (
  select d.*
  from public.task_center_daily_summaries d
  join today t on t.activity_date = d.activity_date
  cross join refresh_summary
),
snapshot_counts as (
  select
    count(*)::integer as snapshot_rows,
    count(*) filter (
      where checkin_source_key = 'daily_bonus'
    )::integer as snapshot_manual_claims,
    count(*) filter (
      where checkin_source_key = 'premium_auto_claim'
    )::integer as snapshot_premium_auto_claims,
    count(*) filter (
      where jsonb_array_length(mission_progress) > 0
    )::integer as snapshot_mission_starters,
    count(*) filter (
      where all_completed = true
    )::integer as snapshot_all_completed
  from public.task_center_reader_daily_snapshots s
  join today t on t.activity_date = s.activity_date
)
select
  case
    when c.snapshots_table_ok
      and c.summaries_table_ok
      and c.maintenance_table_ok
      and c.snapshot_stats_function_ok
      and c.summary_function_ok
      and c.retention_function_ok
      and c.checkin_trigger_ok
      and c.reading_trigger_ok
      and c.mission_trigger_ok
    then 'PASS'
    else 'FAIL'
  end as system_status,
  t.activity_date,
  c.snapshots_table_ok,
  c.summaries_table_ok,
  c.maintenance_table_ok,
  c.snapshot_stats_function_ok,
  c.summary_function_ok,
  c.retention_function_ok,
  c.checkin_trigger_ok,
  c.reading_trigger_ok,
  c.mission_trigger_ok,
  sc.snapshot_rows,
  sc.snapshot_manual_claims,
  sc.snapshot_premium_auto_claims,
  sc.snapshot_mission_starters,
  sc.snapshot_all_completed,
  coalesce(s.active_readers, 0) as active_readers,
  coalesce(s.manual_claims, 0) as manual_claims,
  coalesce(s.premium_auto_claims, 0) as premium_auto_claims,
  coalesce(s.mission_starters, 0) as mission_starters,
  coalesce(s.all_completed_users, 0) as all_completed_users,
  coalesce(s.completion_rate, 0) as completion_rate,
  s.updated_at as summary_updated_at
from checks c
cross join today t
cross join snapshot_counts sc
left join summary s on true;
