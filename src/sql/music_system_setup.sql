create extension if not exists pgcrypto;

create table if not exists public.music_artists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  subtitle text not null default '',
  bio text not null default '',
  avatar_url text not null default '',
  banner_url text not null default '',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.music_artists
alter column subtitle set default '';

update public.music_artists
set subtitle = ''
where subtitle = 'Shadow Music Artist';

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
  view_count bigint not null default 0 check (view_count >= 0),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  track_number integer not null default 1 check (track_number >= 1),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.music_songs
add column if not exists view_count bigint not null default 0 check (view_count >= 0);

create table if not exists public.music_listens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  song_id uuid not null references public.music_songs(id) on delete cascade,
  listened_seconds integer not null default 5 check (listened_seconds >= 5),
  counted_view boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.music_artist_follows (
  user_id uuid not null references public.users(id) on delete cascade,
  artist_id uuid not null references public.music_artists(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);

create index if not exists idx_music_artists_active_sort
on public.music_artists (is_active, sort_order, name);

create index if not exists idx_music_releases_artist_active
on public.music_releases (artist_id, is_active, sort_order);

create index if not exists idx_music_songs_release_active
on public.music_songs (release_id, is_active, track_number, sort_order);

drop index if exists public.idx_music_songs_popular;

create index if not exists idx_music_songs_popular
on public.music_songs (artist_id, view_count desc)
where is_active = true;

create index if not exists idx_music_listens_user_song_created
on public.music_listens (user_id, song_id, created_at desc);

create index if not exists idx_music_listens_song_created
on public.music_listens (song_id, created_at desc);

create index if not exists idx_music_listens_user_created
on public.music_listens (user_id, created_at desc);

create index if not exists idx_music_artist_follows_artist_created
on public.music_artist_follows (artist_id, created_at desc);

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
alter table public.music_listens enable row level security;
alter table public.music_artist_follows enable row level security;

revoke all on public.music_listens from public, anon, authenticated;
grant all on public.music_listens to service_role;

revoke all on public.music_artist_follows from public, anon, authenticated;
grant all on public.music_artist_follows to service_role;

create or replace function public.record_music_listen(
  p_user_id uuid,
  p_song_id uuid,
  p_listened_seconds integer default 5
)
returns table (
  counted boolean,
  current_view_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_counted_at timestamptz;
  v_counted boolean := false;
  v_view_count bigint := 0;
begin
  if p_listened_seconds < 5 then
    raise exception 'A valid music listen requires at least 5 seconds';
  end if;

  if not exists (
    select 1
    from public.users
    where id = p_user_id
      and is_active = true
  ) then
    raise exception 'Reader account not found or inactive';
  end if;

  if not exists (
    select 1
    from public.music_songs
    where id = p_song_id
      and is_active = true
  ) then
    raise exception 'Music song not found or inactive';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_song_id::text, 0)
  );

  select created_at
  into v_last_counted_at
  from public.music_listens
  where user_id = p_user_id
    and song_id = p_song_id
    and counted_view = true
  order by created_at desc
  limit 1;

  if v_last_counted_at is null
     or v_last_counted_at <= now() - interval '30 minutes' then
    update public.music_songs
    set view_count = view_count + 1
    where id = p_song_id
    returning view_count into v_view_count;

    v_counted := true;
  else
    select view_count
    into v_view_count
    from public.music_songs
    where id = p_song_id;
  end if;

  insert into public.music_listens (
    user_id,
    song_id,
    listened_seconds,
    counted_view
  )
  values (
    p_user_id,
    p_song_id,
    p_listened_seconds,
    v_counted
  );

  return query
  select v_counted, coalesce(v_view_count, 0);
end;
$$;

revoke all on function public.record_music_listen(uuid, uuid, integer)
from public, anon, authenticated;

grant execute on function public.record_music_listen(uuid, uuid, integer)
to service_role;

create or replace function public.get_music_artist_listener_totals(
  p_artist_id uuid default null
)
returns table (
  artist_id uuid,
  total_listeners bigint
)
language sql
security definer
set search_path = public
as $$
  select
    s.artist_id,
    count(distinct l.user_id)::bigint as total_listeners
  from public.music_listens l
  join public.music_songs s
    on s.id = l.song_id
  where p_artist_id is null
     or s.artist_id = p_artist_id
  group by s.artist_id;
$$;

revoke all on function public.get_music_artist_listener_totals(uuid)
from public, anon, authenticated;

grant execute on function public.get_music_artist_listener_totals(uuid)
to service_role;
