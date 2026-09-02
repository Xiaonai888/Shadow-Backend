create table if not exists public.music_artist_follows (
  user_id uuid not null references public.users(id) on delete cascade,
  artist_id uuid not null references public.music_artists(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);

create index if not exists idx_music_artist_follows_artist_created
on public.music_artist_follows (artist_id, created_at desc);

alter table public.music_artist_follows enable row level security;

revoke all on public.music_artist_follows from public, anon, authenticated;
grant all on public.music_artist_follows to service_role;
