begin;

create table if not exists public.author_loyalty_reward_progress (
  author_id uuid primary key references public.author_pages(id) on delete cascade,
  user_id uuid not null,
  share_percent numeric(5,2) not null default 50,
  required_episodes integer not null default 20,
  started_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint author_loyalty_reward_share_check check (share_percent = 50),
  constraint author_loyalty_reward_episodes_check check (required_episodes = 20),
  constraint author_loyalty_reward_date_check check (ends_at > started_at)
);

alter table public.author_loyalty_reward_progress enable row level security;

revoke all on public.author_loyalty_reward_progress from public, anon, authenticated;

grant select, insert, update, delete on public.author_loyalty_reward_progress to service_role;

create or replace function public.sync_author_loyalty_reward(p_author_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_started_at timestamptz;
  v_has_20_episodes boolean;
begin
  if p_author_id is null then
    return;
  end if;

  if exists (
    select 1
    from public.author_loyalty_reward_progress r
    where r.author_id = p_author_id
  ) then
    return;
  end if;

  select
    ap.user_id,
    coalesce(
      (
        select p.ends_at
        from public.author_49_day_event_progress p
        where p.author_id = ap.id
          and p.status = 'finished'
          and p.ends_at is not null
          and p.ends_at <= now()
          and p.ends_at + interval '3 years' > now()
        limit 1
      ),
      (
        select b.started_at
        from public.author_daily_80_boost_progress b
        where b.author_id = ap.id
          and b.started_at is not null
        limit 1
      )
    )
  into v_user_id, v_started_at
  from public.author_pages ap
  where ap.id = p_author_id;

  if v_user_id is null or v_started_at is null then
    return;
  end if;

  select exists (
    select 1
    from public.stories s
    join public.episodes e on e.story_id = s.id
    where s.author_id = p_author_id
      and e.status = 'published'
    offset 19 limit 1
  ) into v_has_20_episodes;

  if not v_has_20_episodes then
    return;
  end if;

  insert into public.author_loyalty_reward_progress (
    author_id,
    user_id,
    share_percent,
    required_episodes,
    started_at,
    ends_at
  )
  values (
    p_author_id,
    v_user_id,
    50,
    20,
    v_started_at,
    v_started_at + interval '3 years'
  )
  on conflict (author_id) do nothing;
end;
$$;

create or replace function public.author_loyalty_reward_on_80_start()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.started_at is not null then
    perform public.sync_author_loyalty_reward(new.author_id);
  end if;

  return new;
end;
$$;

create or replace function public.author_loyalty_reward_on_49_finished()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'finished'
     and new.ends_at is not null
     and new.ends_at <= now() then
    perform public.sync_author_loyalty_reward(new.author_id);
  end if;

  return new;
end;
$$;

create or replace function public.author_loyalty_reward_on_episode_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author_id uuid;
begin
  if new.status is distinct from 'published'
     or old.status = 'published'
     or old.published_at is not null then
    return new;
  end if;

  select s.author_id
  into v_author_id
  from public.stories s
  where s.id = new.story_id;

  if v_author_id is not null then
    perform public.sync_author_loyalty_reward(v_author_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_author_loyalty_reward_80_start
  on public.author_daily_80_boost_progress;

create trigger trg_author_loyalty_reward_80_start
after insert or update of started_at on public.author_daily_80_boost_progress
for each row
execute function public.author_loyalty_reward_on_80_start();

drop trigger if exists trg_author_loyalty_reward_49_finished
  on public.author_49_day_event_progress;

create trigger trg_author_loyalty_reward_49_finished
after insert or update of status, ends_at
on public.author_49_day_event_progress
for each row
when (new.status = 'finished')
execute function public.author_loyalty_reward_on_49_finished();

drop trigger if exists trg_zz_author_loyalty_reward_episode_publish
  on public.episodes;

create trigger trg_zz_author_loyalty_reward_episode_publish
after update of status on public.episodes
for each row
when (new.status = 'published')
execute function public.author_loyalty_reward_on_episode_publish();

create or replace function public.get_author_loyalty_reward_state(
  p_author_id uuid,
  p_as_of timestamptz default now()
)
returns table (
  author_id uuid,
  started_at timestamptz,
  ends_at timestamptz,
  total_published_episodes integer,
  last_published_at timestamptz,
  is_active boolean,
  minimum_share_percent numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.author_id,
    r.started_at,
    r.ends_at,
    a.total_published_episodes,
    a.last_published_at,
    eligibility.is_active,
    case
      when eligibility.is_active then r.share_percent
      else 0::numeric
    end
  from public.author_loyalty_reward_progress r
  cross join lateral (
    select
      count(*)::integer as total_published_episodes,
      max(e.published_at) as last_published_at
    from public.stories s
    join public.episodes e on e.story_id = s.id
    where s.author_id = r.author_id
      and e.status = 'published'
  ) a
  cross join lateral (
    select coalesce(
      coalesce(p_as_of, now()) >= r.started_at
      and coalesce(p_as_of, now()) < r.ends_at
      and a.total_published_episodes >= r.required_episodes
      and a.last_published_at >= coalesce(p_as_of, now()) - interval '365 days',
      false
    ) as is_active
  ) eligibility
  where r.author_id = p_author_id;
$$;

insert into public.author_loyalty_reward_progress (
  author_id,
  user_id,
  share_percent,
  required_episodes,
  started_at,
  ends_at
)
select
  p.author_id,
  ap.user_id,
  50,
  20,
  p.ends_at,
  p.ends_at + interval '3 years'
from public.author_49_day_event_progress p
join public.author_pages ap on ap.id = p.author_id
where p.status = 'finished'
  and p.ends_at is not null
  and p.ends_at <= now()
  and p.ends_at + interval '3 years' > now()
  and exists (
    select 1
    from public.stories s
    join public.episodes e on e.story_id = s.id
    where s.author_id = p.author_id
      and e.status = 'published'
    offset 19 limit 1
  )
on conflict (author_id) do nothing;

insert into public.author_loyalty_reward_progress (
  author_id,
  user_id,
  share_percent,
  required_episodes,
  started_at,
  ends_at
)
select
  b.author_id,
  b.user_id,
  50,
  20,
  b.started_at,
  b.started_at + interval '3 years'
from public.author_daily_80_boost_progress b
where b.started_at is not null
  and exists (
    select 1
    from public.stories s
    join public.episodes e on e.story_id = s.id
    where s.author_id = b.author_id
      and e.status = 'published'
    offset 19 limit 1
  )
on conflict (author_id) do nothing;

revoke all on function public.sync_author_loyalty_reward(uuid)
  from public, anon, authenticated;

revoke all on function public.author_loyalty_reward_on_80_start()
  from public, anon, authenticated;

revoke all on function public.author_loyalty_reward_on_49_finished()
  from public, anon, authenticated;

revoke all on function public.author_loyalty_reward_on_episode_publish()
  from public, anon, authenticated;

revoke all on function public.get_author_loyalty_reward_state(uuid, timestamptz)
  from public, anon, authenticated;

grant execute on function public.sync_author_loyalty_reward(uuid)
  to service_role;

grant execute on function public.get_author_loyalty_reward_state(uuid, timestamptz)
  to service_role;

commit;
