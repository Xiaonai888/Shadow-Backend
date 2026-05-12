create extension if not exists "pgcrypto";

create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text unique,
  author_name text not null default '',
  cover_url text not null default '',
  description text not null default '',
  genres text[] not null default '{}',
  status text not null default 'ongoing',
  is_premium boolean not null default false,
  is_active boolean not null default true,
  views_count bigint not null default 0,
  likes_count bigint not null default 0,
  rating numeric(2,1) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.episodes (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  episode_number integer not null,
  title text not null,
  content text not null default '',
  is_free boolean not null default true,
  is_published boolean not null default true,
  published_at timestamptz default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(book_id, episode_number)
);

create index if not exists books_active_created_idx on public.books (is_active, created_at desc);
create index if not exists episodes_book_number_idx on public.episodes (book_id, episode_number);

insert into public.books (
  id,
  title,
  slug,
  author_name,
  cover_url,
  description,
  genres,
  status,
  is_premium,
  is_active,
  views_count,
  likes_count,
  rating
)
values (
  '11111111-1111-1111-1111-111111111111',
  'Call Me As Your Name',
  'call-me-as-your-name',
  'Reaper Of Soul',
  '',
  'Ika is the only survivor of a genocide of humans by demons summoned from another universe and sent to wipe out life on his planet through a portal.',
  array['Romance', 'Action'],
  'ongoing',
  false,
  true,
  1100000,
  200000,
  4.8
)
on conflict (id) do nothing;

insert into public.episodes (
  id,
  book_id,
  episode_number,
  title,
  content,
  is_free,
  is_published
)
values
(
  '22222222-2222-2222-2222-222222222221',
  '11111111-1111-1111-1111-111111111111',
  1,
  'Call me as your name',
  'Ika opened his eyes to a world that had already ended.

The sky was cracked with red light, and the silence after the destruction felt heavier than every scream he had heard before.

He was supposed to disappear with everyone else, but something inside him refused to die.',
  true,
  true
),
(
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  2,
  'See You Again',
  'The next morning felt unreal.

Ika walked through the empty street, passing broken homes and quiet corners where life used to exist.

Every step reminded him that survival was not the same as peace.

Then he saw a mark glowing on the ground, the same symbol that appeared when the demons first arrived.

He clenched his hand and whispered to the empty air, “If you come back, I will be ready.”',
  true,
  true
)
on conflict (id) do nothing;
