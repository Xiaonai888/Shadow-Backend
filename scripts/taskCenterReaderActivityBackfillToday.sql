do $$
declare
  v_today date := (now() at time zone 'Asia/Phnom_Penh')::date;
  v_row record;
begin
  insert into public.task_center_reader_daily_snapshots (
    activity_date,
    user_id,
    checkin_claimed,
    checkin_source_key,
    streak_day,
    last_activity_at
  )
  select
    v_today,
    x.user_id,
    true,
    x.source_key,
    greatest(
      0,
      least(
        7,
        case
          when coalesce(x.metadata->>'day', '') ~ '^[0-9]+$'
            then (x.metadata->>'day')::integer
          when coalesce(x.metadata->>'streak_count', '') ~ '^[0-9]+$'
            then (x.metadata->>'streak_count')::integer
          else 0
        end
      )
    )::smallint,
    x.created_at
  from (
    select distinct on (h.user_id)
      h.user_id,
      h.source_key,
      h.metadata,
      h.created_at
    from public.reader_reward_history h
    where h.source_key in ('daily_bonus', 'premium_auto_claim')
      and (h.created_at at time zone 'Asia/Phnom_Penh')::date = v_today
    order by h.user_id, h.created_at desc
  ) x
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

  insert into public.task_center_reader_daily_snapshots (
    activity_date,
    user_id,
    reading_seconds,
    reading_target_seconds,
    reading_percent,
    last_activity_at
  )
  select
    v_today,
    r.user_id,
    greatest(0, least(1800, coalesce(r.active_seconds, 0))),
    1800,
    least(
      100,
      round(
        greatest(0, least(1800, coalesce(r.active_seconds, 0)))::numeric
        * 100 / 1800
      )::integer
    )::smallint,
    coalesce(r.updated_at, now())
  from public.reader_reading_rewards r
  where r.reward_date = v_today
    and coalesce(r.active_seconds, 0) > 0
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

  insert into public.task_center_reader_daily_snapshots (
    activity_date,
    user_id,
    mission_progress,
    last_activity_at
  )
  select
    v_today,
    p.user_id,
    jsonb_agg(
      jsonb_build_object(
        'mission_id', p.mission_id,
        'title', coalesce(m.title, 'Reading Mission'),
        'active_seconds',
          greatest(
            0,
            least(
              greatest(60, coalesce(m.target_minutes, 1) * 60),
              coalesce(p.active_seconds, 0)
            )
          ),
        'target_seconds',
          greatest(60, coalesce(m.target_minutes, 1) * 60),
        'progress_percent',
          least(
            100,
            round(
              greatest(
                0,
                least(
                  greatest(60, coalesce(m.target_minutes, 1) * 60),
                  coalesce(p.active_seconds, 0)
                )
              )::numeric
              * 100
              / greatest(60, coalesce(m.target_minutes, 1) * 60)
            )::integer
          ),
        'completed',
          p.completed_at is not null
          or coalesce(p.active_seconds, 0)
            >= greatest(60, coalesce(m.target_minutes, 1) * 60),
        'claimed', p.claimed_at is not null,
        'updated_at', coalesce(p.updated_at, now())
      )
      order by m.sort_order asc, m.created_at asc
    ),
    max(coalesce(p.updated_at, now()))
  from public.reader_reading_mission_progress p
  join public.task_center_reading_missions m
    on m.id = p.mission_id
  where m.is_active = true
    and (coalesce(p.updated_at, now()) at time zone 'Asia/Phnom_Penh')::date = v_today
    and (
      coalesce(p.active_seconds, 0) > 0
      or p.completed_at is not null
      or p.claimed_at is not null
    )
  group by p.user_id
  on conflict (activity_date, user_id)
  do update set
    mission_progress = excluded.mission_progress,
    last_activity_at = greatest(
      coalesce(
        public.task_center_reader_daily_snapshots.last_activity_at,
        excluded.last_activity_at
      ),
      excluded.last_activity_at
    ),
    updated_at = now();

  for v_row in
    select user_id
    from public.task_center_reader_daily_snapshots
    where activity_date = v_today
  loop
    perform public.task_center_refresh_reader_snapshot_stats(
      v_today,
      v_row.user_id
    );
  end loop;

  perform public.task_center_refresh_daily_summary(v_today);
end;
$$;
