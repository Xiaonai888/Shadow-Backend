create table if not exists public.google_ads_settings (
  id smallint primary key default 1 check (id = 1),
  master_enabled boolean not null default false,
  home_enabled boolean not null default false,
  story_detail_enabled boolean not null default false,
  reader_end_enabled boolean not null default false,
  episode_unlock_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.google_ads_settings (
  id,
  master_enabled,
  home_enabled,
  story_detail_enabled,
  reader_end_enabled,
  episode_unlock_enabled
)
values (1, false, false, false, false, false)
on conflict (id) do nothing;

alter table public.google_ads_settings enable row level security;
