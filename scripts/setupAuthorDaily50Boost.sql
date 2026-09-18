create table if not exists public.author_daily_50_boost_progress (
  author_id uuid primary key references public.author_pages(id) on delete cascade,
  user_id uuid not null,
  share_percent numeric(5,2) not null default 50,
  activation_count integer not null default 0,
  max_activations integer not null default 365,
  last_activation_date date,
  last_episode_id uuid references public.episodes(id) on delete set null,
  started_at timestamptz,
  ends_at timestamptz,
  status text not null default 'available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint author_daily_50_boost_share_check
    check (share_percent >= 0 and share_percent <= 100),
  constraint author_daily_50_boost_activation_check
    check (activation_count >= 0 and activation_count <= max_activations),
  constraint author_daily_50_boost_max_check
    check (max_activations > 0)
);

create index if not exists author_daily_50_boost_user_idx
  on public.author_daily_50_boost_progress(user_id);

create index if not exists author_daily_50_boost_status_idx
  on public.author_daily_50_boost_progress(status, ends_at);

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
    (
      public.author_daily_50_boost_progress.last_activation_date is null
      or public.author_daily_50_boost_progress.last_activation_date <> v_today
    )
    and public.author_daily_50_boost_progress.activation_count
      < public.author_daily_50_boost_progress.max_activations;

  return new;
end;
$$;

drop trigger if exists trg_author_daily_50_boost_publish
  on public.episodes;

create trigger trg_author_daily_50_boost_publish
after update of status on public.episodes
for each row
when (new.status = 'published')
execute function public.activate_author_daily_50_boost_on_publish();
