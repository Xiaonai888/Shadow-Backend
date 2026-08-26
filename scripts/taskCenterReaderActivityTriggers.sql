create or replace function public.task_center_refresh_reader_snapshot_stats(
  p_activity_date date,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active_reading_missions integer := 0;
  v_completed_reading_missions integer := 0;
  v_checkin_claimed boolean := false;
  v_reading_seconds integer := 0;
  v_total integer := 0;
  v_completed integer := 0;
begin
  select count(*)
  into v_active_reading_missions
  from public.task_center_reading_missions
  where is_active = true;

  select
    s.checkin_claimed,
    s.reading_seconds,
    coalesce((
      select count(*)
      from jsonb_array_elements(s.mission_progress) as item
      where coalesce((item->>'completed')::boolean, false) = true
    ), 0)
  into
    v_checkin_claimed,
    v_reading_seconds,
    v_completed_reading_missions
  from public.task_center_reader_daily_snapshots s
  where s.activity_date = p_activity_date
    and s.user_id = p_user_id;

  if not found then
    return;
  end if;

  v_total := v_active_reading_missions + 2;
  v_completed :=
    case when v_checkin_claimed then 1 else 0 end
    + case when v_reading_seconds >= 1800 then 1 else 0 end
    + least(v_completed_reading_missions, v_active_reading_missions);

  update public.task_center_reader_daily_snapshots
  set
    missions_total = v_total::smallint,
    missions_completed = v_completed::smallint,
    all_completed = v_completed >= v_total,
    updated_at = now()
  where activity_date = p_activity_date
    and user_id = p_user_id;
end;
$$;

create or replace function public.task_center_capture_checkin_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_date date;
  v_activity_at timestamptz;
  v_streak_day integer := 0;
begin
  if new.source_key not in ('daily_bonus', 'premium_auto_claim') then
    return new;
  end if;

  v_activity_at := coalesce(new.created_at, now());
  v_activity_date := (v_activity_at at time zone 'Asia/Phnom_Penh')::date;

  if coalesce(new.metadata->>'day', '') ~ '^[0-9]+$' then
    v_streak_day := greatest(0, least(7, (new.metadata->>'day')::integer));
  elsif coalesce(new.metadata->>'streak_count', '') ~ '^[0-9]+$' then
    v_streak_day := greatest(0, least(7, (new.metadata->>'streak_count')::integer));
  end if;

  insert into public.task_center_reader_daily_snapshots (
    activity_date,
    user_id,
    checkin_claimed,
    checkin_source_key,
    streak_day,
    last_activity_at
  )
  values (
    v_activity_date,
    new.user_id,
    true,
    new.source_key,
    v_streak_day,
    v_activity_at
  )
  on conflict (activity_date, user_id)
  do update set
    checkin_claimed = true,
    checkin_source_key = excluded.checkin_source_key,
    streak_day = greatest(
      public.task_center_reader_daily_snapshots.streak_day,
      excluded.streak_day
    ),
    last_activity_at = greatest(
      coalesce(
        public.task_center_reader_daily_snapshots.last_activity_at,
        excluded.last_activity_at
      ),
      excluded.last_activity_at
    ),
    updated_at = now();

  perform public.task_center_refresh_reader_snapshot_stats(
    v_activity_date,
    new.user_id
  );

  return new;
end;
$$;

create or replace function public.task_center_capture_reading_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_date date;
  v_activity_at timestamptz;
  v_new_seconds integer := 0;
  v_old_seconds integer := 0;
  v_new_bucket integer := 0;
  v_old_bucket integer := 0;
  v_percent integer := 0;
begin
  v_new_seconds := greatest(0, least(1800, coalesce(new.active_seconds, 0)));

  if v_new_seconds <= 0 then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old_seconds := greatest(0, least(1800, coalesce(old.active_seconds, 0)));
    v_new_bucket := floor((v_new_seconds::numeric * 10) / 1800)::integer;
    v_old_bucket := floor((v_old_seconds::numeric * 10) / 1800)::integer;

    if v_old_seconds > 0
      and v_new_seconds < 1800
      and v_new_bucket = v_old_bucket then
      return new;
    end if;
  end if;

  v_activity_date := coalesce(new.reward_date, (now() at time zone 'Asia/Phnom_Penh')::date);
  v_activity_at := coalesce(new.updated_at, now());
  v_percent := least(100, round((v_new_seconds::numeric * 100) / 1800)::integer);

  insert into public.task_center_reader_daily_snapshots (
    activity_date,
    user_id,
    reading_seconds,
    reading_target_seconds,
    reading_percent,
    last_activity_at
  )
  values (
    v_activity_date,
    new.user_id,
    v_new_seconds,
    1800,
    v_percent,
    v_activity_at
  )
  on conflict (activity_date, user_id)
  do update set
    reading_seconds = greatest(
      public.task_center_reader_daily_snapshots.reading_seconds,
      excluded.reading_seconds
    ),
    reading_target_seconds = 1800,
    reading_percent = greatest(
      public.task_center_reader_daily_snapshots.reading_percent,
      excluded.reading_percent
    ),
    last_activity_at = greatest(
      coalesce(
        public.task_center_reader_daily_snapshots.last_activity_at,
        excluded.last_activity_at
      ),
      excluded.last_activity_at
    ),
    updated_at = now();

  perform public.task_center_refresh_reader_snapshot_stats(
    v_activity_date,
    new.user_id
  );

  return new;
end;
$$;

create or replace function public.task_center_capture_mission_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_date date;
  v_activity_at timestamptz;
  v_target_seconds integer := 60;
  v_title text := '';
  v_new_seconds integer := 0;
  v_old_seconds integer := 0;
  v_new_bucket integer := 0;
  v_old_bucket integer := 0;
  v_percent integer := 0;
  v_completed boolean := false;
  v_old_completed boolean := false;
  v_claimed boolean := false;
  v_old_claimed boolean := false;
  v_payload jsonb;
begin
  select
    coalesce(title, 'Reading Mission'),
    greatest(60, coalesce(target_minutes, 1) * 60)
  into
    v_title,
    v_target_seconds
  from public.task_center_reading_missions
  where id = new.mission_id;

  if not found then
    return new;
  end if;

  v_new_seconds := greatest(
    0,
    least(v_target_seconds, coalesce(new.active_seconds, 0))
  );
  v_completed := new.completed_at is not null or v_new_seconds >= v_target_seconds;
  v_claimed := new.claimed_at is not null;

  if v_new_seconds <= 0 and not v_completed and not v_claimed then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old_seconds := greatest(
      0,
      least(v_target_seconds, coalesce(old.active_seconds, 0))
    );
    v_old_completed := old.completed_at is not null or v_old_seconds >= v_target_seconds;
    v_old_claimed := old.claimed_at is not null;
    v_new_bucket := floor((v_new_seconds::numeric * 10) / v_target_seconds)::integer;
    v_old_bucket := floor((v_old_seconds::numeric * 10) / v_target_seconds)::integer;

    if v_old_seconds > 0
      and v_new_seconds < v_target_seconds
      and v_new_bucket = v_old_bucket
      and v_completed = v_old_completed
      and v_claimed = v_old_claimed then
      return new;
    end if;
  end if;

  v_activity_at := coalesce(new.updated_at, now());
  v_activity_date := (v_activity_at at time zone 'Asia/Phnom_Penh')::date;
  v_percent := least(
    100,
    round((v_new_seconds::numeric * 100) / v_target_seconds)::integer
  );

  v_payload := jsonb_build_object(
    'mission_id', new.mission_id,
    'title', v_title,
    'active_seconds', v_new_seconds,
    'target_seconds', v_target_seconds,
    'progress_percent', v_percent,
    'completed', v_completed,
    'claimed', v_claimed,
    'updated_at', v_activity_at
  );

  insert into public.task_center_reader_daily_snapshots (
    activity_date,
    user_id,
    last_activity_at
  )
  values (
    v_activity_date,
    new.user_id,
    v_activity_at
  )
  on conflict (activity_date, user_id)
  do nothing;

  update public.task_center_reader_daily_snapshots s
  set
    mission_progress =
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(s.mission_progress) as item
        where item->>'mission_id' <> new.mission_id::text
      ), '[]'::jsonb)
      || jsonb_build_array(v_payload),
    last_activity_at = greatest(
      coalesce(s.last_activity_at, v_activity_at),
      v_activity_at
    ),
    updated_at = now()
  where s.activity_date = v_activity_date
    and s.user_id = new.user_id;

  perform public.task_center_refresh_reader_snapshot_stats(
    v_activity_date,
    new.user_id
  );

  return new;
end;
$$;

drop trigger if exists task_center_capture_checkin_activity_trigger
on public.reader_reward_history;

create trigger task_center_capture_checkin_activity_trigger
after insert on public.reader_reward_history
for each row
execute function public.task_center_capture_checkin_activity();

drop trigger if exists task_center_capture_reading_activity_trigger
on public.reader_reading_rewards;

create trigger task_center_capture_reading_activity_trigger
after insert or update of active_seconds
on public.reader_reading_rewards
for each row
execute function public.task_center_capture_reading_activity();

drop trigger if exists task_center_capture_mission_activity_trigger
on public.reader_reading_mission_progress;

create trigger task_center_capture_mission_activity_trigger
after insert or update of active_seconds, completed_at, claimed_at, updated_at
on public.reader_reading_mission_progress
for each row
execute function public.task_center_capture_mission_activity();
