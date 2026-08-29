create extension if not exists pgcrypto;

create table if not exists public.music_artists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  subtitle text not null default 'Shadow Music Artist',
  bio text not null default '',
  avatar_url text not null default '',
  banner_url text not null default '',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.music_releases (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.music_artists(id) on delete cascade,
  title text not null,
  slug text not null,
  release_type text not null check (release_type in ('album', 'single')),
  cover_url text not null default '',
  release_year integer not null default extract(year from now())::integer check (release_year between 1900 and 2100),
  release_date date,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (artist_id, slug)
);

create table if not exists public.music_songs (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.music_artists(id) on delete cascade,
  release_id uuid not null references public.music_releases(id) on delete cascade,
  title text not null,
  youtube_url text not null,
  youtube_video_id text not null,
  youtube_view_count bigint not null default 0 check (youtube_view_count >= 0),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  track_number integer not null default 1 check (track_number >= 1),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_music_artists_active_sort on public.music_artists (is_active, sort_order, name);
create index if not exists idx_music_releases_artist_active on public.music_releases (artist_id, is_active, sort_order);
create index if not exists idx_music_songs_release_active on public.music_songs (release_id, is_active, track_number, sort_order);
create index if not exists idx_music_songs_popular on public.music_songs (artist_id, youtube_view_count desc) where is_active = true;

create or replace function public.set_music_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists music_artists_updated_at on public.music_artists;
create trigger music_artists_updated_at
before update on public.music_artists
for each row execute function public.set_music_updated_at();

drop trigger if exists music_releases_updated_at on public.music_releases;
create trigger music_releases_updated_at
before update on public.music_releases
for each row execute function public.set_music_updated_at();

drop trigger if exists music_songs_updated_at on public.music_songs;
create trigger music_songs_updated_at
before update on public.music_songs
for each row execute function public.set_music_updated_at();

alter table public.music_artists enable row level security;
alter table public.music_releases enable row level security;
alter table public.music_songs enable row level security;
