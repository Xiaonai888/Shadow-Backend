create table if not exists public.reader_weekly_reading_episodes (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  week_start date not null,
  story_id uuid not null references public.stories(id) on delete cascade,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  counted_at timestamptz not null default now(),
  unique (user_id, week_start, episode_id)
);

create table if not exists public.reader_weekly_reading_claims (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  week_start date not null,
  milestone integer not null check (
    milestone >= 10
    and milestone <= 100
    and milestone % 10 = 0
  ),
  vouchers integer not null default 1 check (vouchers = 1),
  auto_claimed boolean not null default false,
  claimed_at timestamptz not null default now(),
  unique (user_id, week_start, milestone)
);

create index if not exists idx_reader_weekly_reading_episodes_user_week
on public.reader_weekly_reading_episodes (user_id, week_start);

create index if not exists idx_reader_weekly_reading_claims_user_week
on public.reader_weekly_reading_claims (user_id, week_start);

alter table public.reader_weekly_reading_episodes enable row level security;
alter table public.reader_weekly_reading_claims enable row level security;

revoke all on table public.reader_weekly_reading_episodes from anon, authenticated;
revoke all on table public.reader_weekly_reading_claims from anon, authenticated;
