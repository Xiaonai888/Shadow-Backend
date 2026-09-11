create table if not exists public.game_settings (
  game_key text primary key,
  name text not null,
  profile_url text,
  profile_storage_key text,
  hidden boolean not null default false,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.game_settings enable row level security;
