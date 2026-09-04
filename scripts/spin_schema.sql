create extension if not exists pgcrypto;

create table if not exists public.spin_wheels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null default 'Shadow Spin',
  mode text not null default 'normal' check (mode in ('normal', 'shadow')),
  entries jsonb not null default '[]'::jsonb check (jsonb_typeof(entries) = 'array'),
  prizes jsonb not null default '[]'::jsonb check (jsonb_typeof(prizes) = 'array'),
  background_url text,
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists spin_wheels_user_updated_idx
  on public.spin_wheels (user_id, updated_at desc);

create table if not exists public.spin_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  wheel_id uuid references public.spin_wheels(id) on delete set null,
  wheel_title text not null default 'Shadow Spin',
  mode text not null default 'normal' check (mode in ('normal', 'shadow')),
  winner jsonb not null check (jsonb_typeof(winner) = 'object'),
  prize jsonb,
  created_at timestamptz not null default now(),
  constraint spin_results_prize_object_check
    check (prize is null or jsonb_typeof(prize) = 'object')
);

create index if not exists spin_results_user_created_idx
  on public.spin_results (user_id, created_at desc);
