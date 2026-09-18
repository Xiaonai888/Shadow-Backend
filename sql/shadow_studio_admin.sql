create table if not exists public.app_settings (
  app_key text primary key,
  name text not null,
  profile_url text,
  hidden boolean not null default false,
  disabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (
  app_key,
  name,
  profile_url,
  hidden,
  disabled
)
values (
  'shadow-studio',
  'Shadow Studio',
  null,
  false,
  false
)
on conflict (app_key) do nothing;

create table if not exists public.studio_brushes (
  id uuid primary key,
  app_key text not null references public.app_settings(app_key) on delete cascade,
  name text not null,
  source_type text not null check (source_type in ('image', 'abr')),
  file_url text not null,
  thumbnail_url text,
  original_file_name text,
  mime_type text,
  active boolean not null default true,
  sort_order integer not null default 0,
  version integer not null default 1 check (version >= 1),
  settings jsonb not null default '{"size":40,"opacity":100,"spacing":10,"hardness":100}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists studio_brushes_app_sort_idx
  on public.studio_brushes (app_key, sort_order, created_at);

create index if not exists studio_brushes_app_active_idx
  on public.studio_brushes (app_key, active);

alter table public.app_settings enable row level security;
alter table public.studio_brushes enable row level security;
