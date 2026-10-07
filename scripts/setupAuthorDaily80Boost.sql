create table if not exists public.author_daily_80_boost_progress (
  author_id uuid primary key references public.author_pages(id) on delete cascade,
  user_id uuid not null,
  share_percent numeric(5,2) not null default 80,
  activation_count integer not null default 0,
  max_activations integer not null default 180,
  last_activation_date date,
  last_episode_id uuid references public.episodes(id) on delete set null,
  started_at timestamptz,
  ends_at timestamptz,
  status text not null default 'available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint author_daily_80_boost_share_check
    check (share_percent >= 0 and share_percent <= 100),
  constraint author_daily_80_boost_activation_check
    check (activation_count >= 0 and activation_count <= max_activations),
  constraint author_daily_80_boost_max_check
    check (max_activations > 0)
);

create index if not exists author_daily_80_boost_user_idx
  on public.author_daily_80_boost_progress(user_id);

create index if not exists author_daily_80_boost_status_idx
  on public.author_daily_80_boost_progress(status, ends_at);

alter table public.author_daily_50_boost_progress
  add column if not exists event_80_paused_at timestamptz,
  add column if not exists event_80_remaining_seconds bigint;

create or replace function public.pause_author_daily_50_for_80(p_author_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  update public.author_daily_50_boost_progress
  set
    event_80_paused_at = coalesce(event_80_paused_at, v_now),
    event_80_remaining_seconds = case
      when event_80_paused_at is not null then event_80_remaining_seconds
      when status = 'active' and ends_at is not null and ends_at > v_now
        then greatest(0, ceil(extract(epoch from (ends_at - v_now)))::bigint)
      else 0
    end,
    status = case
      when status = 'finished' then status
      else 'paused_by_80_event'
    end,
    updated_at = v_now
  where author_id = p_author_id
    and status <> 'finished';
end;
$$;

create or replace function public.resume_author_daily_50_after_80(p_author_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.author_daily_50_boost_progress%rowtype;
  v_remaining bigint;
begin
  select *
  into v_row
  from public.author_daily_50_boost_progress
  where author_id = p_author_id
  for update;

  if not found or v_row.event_80_paused_at is null then
    return;
  end if;

  v_remaining := greatest(0, coalesce(v_row.event_80_remaining_seconds, 0));

  update public.author_daily_50_boost_progress
  set
    status = case
      when v_remaining > 0 then 'active'
      when activation_count >= max_activations then 'finished'
      else 'available'
    end,
    ends_at = case
      when v_remaining > 0 then v_now + v_remaining * interval '1 second'
      else null
    end,
    event_80_paused_at = null,
    event_80_remaining_seconds = null,
    updated_at = v_now
  where author_id = p_author_id;
end;
$$;

create or replace function public.activate_author_daily_80_boost_on_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author_id uuid;
  v_user_id uuid;
  v_today date := (now() at time zone 'Asia/Phnom_Penh')::date;
  v_49_status text;
  v_49_ends_at timestamptz;
  v_80 public.author_daily_80_boost_progress%rowtype;
begin
  if new.status is distinct from 'published' then
    return new;
  end if;

  if old.status = 'published' then
    return new;
  end if;

  if old.published_at is not null then
    return new;
  end if;

  select s.author_id
  into v_author_id
  from public.stories s
  where s.id = new.story_id
  limit 1;

  if v_author_id is null then
    return new;
  end if;

  select ap.user_id
  into v_user_id
  from public.author_pages ap
  where ap.id = v_author_id
  limit 1;

  if v_user_id is null then
    return new;
  end if;

  select p.status, p.ends_at
  into v_49_status, v_49_ends_at
  from public.author_49_day_event_progress p
  where p.author_id = v_author_id
  limit 1;

  if (
    v_49_status = 'active'
    and v_49_ends_at is not null
    and v_49_ends_at <= now()
  ) then
    update public.author_49_day_event_progress
    set
      status = 'finished',
      ended_at = coalesce(ended_at, now()),
      end_reason = coalesce(end_reason, '49_days_completed'),
      updated_at = now()
    where author_id = v_author_id
      and status = 'active';

    v_49_status := 'finished';
  end if;

  if coalesce(v_49_status, '') <> 'finished' then
    return new;
  end if;

  if exists (
    select 1
    from public.author_100_percent_event_cycles c
    where c.author_id = v_author_id
      and c.status = 'active'
      and c.last_resumed_at + c.remaining_seconds * interval '1 second' > now()
  ) then
    return new;
  end if;

  if exists (
    select 1
    from public.author_lifetime_boosts b
    where b.author_id = v_author_id
      and b.boost_type = '100_percent_100_days'
      and b.status = 'active'
      and b.admin_event_pause_cycle_id is null
      and (b.ended_at is null or b.ended_at > now())
  ) then
    return new;
  end if;

  select *
  into v_80
  from public.author_daily_80_boost_progress
  where author_id = v_author_id
  for update;

  if found then
    if (
      v_80.status = 'active'
      and v_80.ends_at is not null
      and v_80.ends_at <= now()
    ) then
      if v_80.activation_count >= v_80.max_activations then
        update public.author_daily_80_boost_progress
        set
          status = 'finished',
          updated_at = now()
        where author_id = v_author_id;

        perform public.resume_author_daily_50_after_80(v_author_id);
        return new;
      end if;

      update public.author_daily_80_boost_progress
      set
        status = 'available',
        updated_at = now()
      where author_id = v_author_id;

      v_80.status := 'available';
    end if;

    if v_80.status = 'finished' then
      perform public.resume_author_daily_50_after_80(v_author_id);
      return new;
    end if;
  end if;

  perform public.pause_author_daily_50_for_80(v_author_id);

  insert into public.author_daily_80_boost_progress (
    author_id,
    user_id,
    share_percent,
    activation_count,
    max_activations,
    last_activation_date,
    last_episode_id,
    started_at,
    ends_at,
    status,
    updated_at
  )
  values (
    v_author_id,
    v_user_id,
    80,
    1,
    180,
    v_today,
    new.id,
    now(),
    now() + interval '24 hours',
    'active',
    now()
  )
  on conflict (author_id)
  do update set
    user_id = excluded.user_id,
    share_percent = 80,
    activation_count =
      public.author_daily_80_boost_progress.activation_count + 1,
    last_activation_date = v_today,
    last_episode_id = new.id,
    started_at = coalesce(
      public.author_daily_80_boost_progress.started_at,
      now()
    ),
    ends_at =
      greatest(
        coalesce(
          public.author_daily_80_boost_progress.ends_at,
          now()
        ),
        now()
      ) + interval '24 hours',
    status = 'active',
    updated_at = now()
  where
    public.author_daily_80_boost_progress.status <> 'finished'
    and (
      public.author_daily_80_boost_progress.last_activation_date is null
      or public.author_daily_80_boost_progress.last_activation_date <> v_today
    )
    and public.author_daily_80_boost_progress.activation_count
      < public.author_daily_80_boost_progress.max_activations;

  return new;
end;
$$;

drop trigger if exists trg_00_author_daily_80_boost_publish
  on public.episodes;

create trigger trg_00_author_daily_80_boost_publish
after update of status on public.episodes
for each row
when (new.status = 'published')
execute function public.activate_author_daily_80_boost_on_publish();

create or replace function public.activate_author_daily_50_boost_on_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author_id uuid;
  v_user_id uuid;
  v_today date := (now() at time zone 'Asia/Phnom_Penh')::date;
  v_49_status text;
  v_49_ends_at timestamptz;
  v_80_status text;
begin
  if new.status is distinct from 'published' then
    return new;
  end if;

  if old.status = 'published' then
    return new;
  end if;

  if old.published_at is not null then
    return new;
  end if;

  select s.author_id
  into v_author_id
  from public.stories s
  where s.id = new.story_id
  limit 1;

  if v_author_id is null then
    return new;
  end if;

  select ap.user_id
  into v_user_id
  from public.author_pages ap
  where ap.id = v_author_id
  limit 1;

  if v_user_id is null then
    return new;
  end if;

  select p.status, p.ends_at
  into v_49_status, v_49_ends_at
  from public.author_49_day_event_progress p
  where p.author_id = v_author_id
  limit 1;

  if (
    v_49_status = 'active'
    and v_49_ends_at is not null
    and v_49_ends_at <= now()
  ) then
    update public.author_49_day_event_progress
    set
      status = 'finished',
      ended_at = coalesce(ended_at, now()),
      end_reason = coalesce(end_reason, '49_days_completed'),
      updated_at = now()
    where author_id = v_author_id
      and status = 'active';

    v_49_status := 'finished';
  end if;

  if coalesce(v_49_status, '') <> 'finished' then
    return new;
  end if;

  select p.status
  into v_80_status
  from public.author_daily_80_boost_progress p
  where p.author_id = v_author_id
  limit 1;

  if coalesce(v_80_status, '') <> 'finished' then
    return new;
  end if;

  if exists (
    select 1
    from public.author_lifetime_boosts b
    where b.author_id = v_author_id
      and b.boost_type = '100_percent_100_days'
      and b.status = 'active'
      and (b.ended_at is null or b.ended_at > now())
  ) then
    return new;
  end if;

  insert into public.author_daily_50_boost_progress (
    author_id,
    user_id,
    share_percent,
    activation_count,
    max_activations,
    last_activation_date,
    last_episode_id,
    started_at,
    ends_at,
    status,
    updated_at
  )
  values (
    v_author_id,
    v_user_id,
    50,
    1,
    365,
    v_today,
    new.id,
    now(),
    now() + interval '24 hours',
    'active',
    now()
  )
  on conflict (author_id)
  do update set
    user_id = excluded.user_id,
    share_percent = 50,
    activation_count =
      public.author_daily_50_boost_progress.activation_count + 1,
    last_activation_date = v_today,
    last_episode_id = new.id,
    started_at = coalesce(
      public.author_daily_50_boost_progress.started_at,
      now()
    ),
    ends_at =
      greatest(
        coalesce(
          public.author_daily_50_boost_progress.ends_at,
          now()
        ),
        now()
      ) + interval '24 hours',
    status = 'active',
    updated_at = now()
  where
    public.author_daily_50_boost_progress.event_80_paused_at is null
    and (
      public.author_daily_50_boost_progress.last_activation_date is null
      or public.author_daily_50_boost_progress.last_activation_date <> v_today
    )
    and public.author_daily_50_boost_progress.activation_count
      < public.author_daily_50_boost_progress.max_activations;

  return new;
end;
$$;

update public.author_daily_50_boost_progress d
set
  event_80_paused_at = coalesce(d.event_80_paused_at, clock_timestamp()),
  event_80_remaining_seconds = case
    when d.event_80_paused_at is not null then d.event_80_remaining_seconds
    when d.status = 'active' and d.ends_at is not null and d.ends_at > clock_timestamp()
      then greatest(0, ceil(extract(epoch from (d.ends_at - clock_timestamp())))::bigint)
    else 0
  end,
  status = 'paused_by_80_event',
  updated_at = clock_timestamp()
where d.status <> 'finished'
  and exists (
    select 1
    from public.author_49_day_event_progress p
    where p.author_id = d.author_id
      and p.status = 'finished'
  );

revoke all on function public.pause_author_daily_50_for_80(uuid)
  from public, anon, authenticated;

revoke all on function public.resume_author_daily_50_after_80(uuid)
  from public, anon, authenticated;

revoke all on function public.activate_author_daily_80_boost_on_publish()
  from public, anon, authenticated;

grant execute on function public.pause_author_daily_50_for_80(uuid)
  to service_role;

grant execute on function public.resume_author_daily_50_after_80(uuid)
  to service_role;
