create table if not exists public.task_center_activity_maintenance (
  maintenance_key text primary key,
  last_retention_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.task_center_activity_maintenance (
  maintenance_key
)
values ('main')
on conflict (maintenance_key) do nothing;

alter table public.task_center_activity_maintenance enable row level security;

revoke all on table public.task_center_activity_maintenance from anon;
revoke all on table public.task_center_activity_maintenance from authenticated;
grant all on table public.task_center_activity_maintenance to service_role;

create or replace function public.task_center_refresh_daily_summary(
  p_activity_date date
)
returns public.task_center_daily_summaries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active_readers integer := 0;
  v_manual_claims integer := 0;
  v_premium_auto_claims integer := 0;
  v_mission_starters integer := 0;
  v_all_completed_users integer := 0;
  v_completion_rate numeric(5,2) := 0;
  v_result public.task_center_daily_summaries;
begin
  select
    count(*)::integer,
    count(*) filter (
      where checkin_claimed = true
        and checkin_source_key = 'daily_bonus'
    )::integer,
    count(*) filter (
      where checkin_claimed = true
        and checkin_source_key = 'premium_auto_claim'
    )::integer,
    count(*) filter (
      where jsonb_array_length(mission_progress) > 0
    )::integer,
    count(*) filter (
      where all_completed = true
    )::integer
  into
    v_active_readers,
    v_manual_claims,
    v_premium_auto_claims,
    v_mission_starters,
    v_all_completed_users
  from public.task_center_reader_daily_snapshots
  where activity_date = p_activity_date;

  if v_active_readers > 0 then
    v_completion_rate := round(
      (v_all_completed_users::numeric * 100) / v_active_readers,
      2
    );
  end if;

  insert into public.task_center_daily_summaries (
    activity_date,
    active_readers,
    manual_claims,
    premium_auto_claims,
    mission_starters,
    all_completed_users,
    completion_rate,
    updated_at
  )
  values (
    p_activity_date,
    v_active_readers,
    v_manual_claims,
    v_premium_auto_claims,
    v_mission_starters,
    v_all_completed_users,
    v_completion_rate,
    now()
  )
  on conflict (activity_date)
  do update set
    active_readers = excluded.active_readers,
    manual_claims = excluded.manual_claims,
    premium_auto_claims = excluded.premium_auto_claims,
    mission_starters = excluded.mission_starters,
    all_completed_users = excluded.all_completed_users,
    completion_rate = excluded.completion_rate,
    updated_at = now()
  returning *
  into v_result;

  return v_result;
end;
$$;

create or replace function public.task_center_run_activity_retention()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Phnom_Penh')::date;
  v_last_retention_at timestamptz;
  v_compacted integer := 0;
  v_deleted_snapshots integer := 0;
  v_deleted_summaries integer := 0;
  v_backfilled_summaries integer := 0;
  v_date date;
begin
  select last_retention_at
  into v_last_retention_at
  from public.task_center_activity_maintenance
  where maintenance_key = 'main'
  for update;

  if v_last_retention_at is not null
    and v_last_retention_at > now() - interval '24 hours' then
    return jsonb_build_object(
      'ok', true,
      'skipped', true,
      'last_retention_at', v_last_retention_at
    );
  end if;

  for v_date in
    select distinct s.activity_date
    from public.task_center_reader_daily_snapshots s
    where s.activity_date < v_today - 14
      and s.activity_date >= v_today - 365
      and not exists (
        select 1
        from public.task_center_daily_summaries d
        where d.activity_date = s.activity_date
      )
    order by s.activity_date
  loop
    perform public.task_center_refresh_daily_summary(v_date);
    v_backfilled_summaries := v_backfilled_summaries + 1;
  end loop;

  update public.task_center_reader_daily_snapshots
  set
    mission_progress = '[]'::jsonb,
    updated_at = now()
  where activity_date < v_today - 14
    and activity_date >= v_today - 365
    and mission_progress <> '[]'::jsonb;

  get diagnostics v_compacted = row_count;

  delete from public.task_center_reader_daily_snapshots
  where activity_date < v_today - 365;

  get diagnostics v_deleted_snapshots = row_count;

  delete from public.task_center_daily_summaries
  where activity_date < v_today - 1095;

  get diagnostics v_deleted_summaries = row_count;

  update public.task_center_activity_maintenance
  set
    last_retention_at = now(),
    updated_at = now()
  where maintenance_key = 'main';

  return jsonb_build_object(
    'ok', true,
    'skipped', false,
    'backfilled_summaries', v_backfilled_summaries,
    'compacted_snapshots', v_compacted,
    'deleted_snapshots', v_deleted_snapshots,
    'deleted_summaries', v_deleted_summaries,
    'retained_full_detail_days', 14,
    'retained_user_summary_days', 365,
    'retained_platform_summary_days', 1095
  );
end;
$$;
