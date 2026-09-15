create extension if not exists pgcrypto;

create table if not exists public.rewarded_ad_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  story_id text not null,
  episode_id text not null,
  event_type text not null check (
    event_type in (
      'started',
      'ready',
      'cancelled',
      'no_fill',
      'error',
      'daily_limit_reached'
    )
  ),
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists rewarded_ad_events_created_idx
  on public.rewarded_ad_events (created_at desc);

create index if not exists rewarded_ad_events_user_created_idx
  on public.rewarded_ad_events (user_id, created_at desc);

create index if not exists rewarded_ad_events_type_created_idx
  on public.rewarded_ad_events (event_type, created_at desc);

alter table public.rewarded_ad_events enable row level security;

create or replace function public.get_rewarded_ad_analytics(
  p_since timestamptz
)
returns table (
  started bigint,
  ready bigint,
  cancelled bigint,
  no_fill bigint,
  errors bigint,
  daily_limit_reached bigint,
  reward_granted bigint,
  unique_users bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with events as (
    select
      user_id,
      event_type
    from public.rewarded_ad_events
    where created_at >= p_since
  ),
  grants as (
    select
      user_id::text as user_id
    from public.episode_unlock_transactions
    where created_at >= p_since
      and currency = 'ad'
      and type = 'unlock'
  ),
  users as (
    select user_id from events
    union
    select user_id from grants
  )
  select
    count(*) filter (
      where event_type = 'started'
    )::bigint,
    count(*) filter (
      where event_type = 'ready'
    )::bigint,
    count(*) filter (
      where event_type = 'cancelled'
    )::bigint,
    count(*) filter (
      where event_type = 'no_fill'
    )::bigint,
    count(*) filter (
      where event_type = 'error'
    )::bigint,
    count(*) filter (
      where event_type = 'daily_limit_reached'
    )::bigint,
    (
      select count(*)::bigint
      from grants
    ),
    (
      select count(*)::bigint
      from users
    )
  from events;
$$;

revoke all on function public.get_rewarded_ad_analytics(timestamptz) from public;
grant execute on function public.get_rewarded_ad_analytics(timestamptz) to service_role;
