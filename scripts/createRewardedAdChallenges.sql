create extension if not exists pgcrypto;

create table if not exists public.rewarded_ad_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  story_id text not null,
  episode_id text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists rewarded_ad_challenges_user_created_idx
  on public.rewarded_ad_challenges (user_id, created_at desc);

create index if not exists rewarded_ad_challenges_expires_idx
  on public.rewarded_ad_challenges (expires_at);

create unique index if not exists rewarded_ad_challenges_one_active_user_idx
  on public.rewarded_ad_challenges (user_id)
  where consumed_at is null;

alter table public.rewarded_ad_challenges enable row level security;
