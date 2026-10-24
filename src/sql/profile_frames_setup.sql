begin;

create table if not exists public.profile_frames (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  image_url text not null check (image_url ~* '^https://[^[:space:]]+$'),
  storage_key text not null check (char_length(btrim(storage_key)) between 1 and 1024),
  access_tier text not null default 'free' check (access_tier in ('free', 'premium')),
  is_active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reader_profile_frame_selections (
  user_id uuid primary key references public.users(id) on delete cascade,
  frame_id uuid references public.profile_frames(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists profile_frames_catalog_idx
  on public.profile_frames (is_active, access_tier, sort_order, created_at desc, id);

create index if not exists profile_frames_admin_order_idx
  on public.profile_frames (sort_order, created_at desc, id);

create index if not exists reader_profile_frame_selections_frame_idx
  on public.reader_profile_frame_selections (frame_id)
  where frame_id is not null;

alter table public.profile_frames enable row level security;
alter table public.reader_profile_frame_selections enable row level security;

revoke all on public.profile_frames from public, anon, authenticated;
revoke all on public.reader_profile_frame_selections from public, anon, authenticated;

grant select, insert, update, delete on public.profile_frames to service_role;
grant select, insert, update, delete on public.reader_profile_frame_selections to service_role;

commit;
