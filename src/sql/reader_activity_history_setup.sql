begin;

create table if not exists public.reader_activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  category text not null check (category in ('interactions', 'reading', 'transactions', 'security')),
  action text not null check (char_length(action) between 2 and 64),
  subject_type text check (subject_type is null or char_length(subject_type) <= 40),
  subject_id text check (subject_id is null or char_length(subject_id) <= 128),
  description text check (description is null or char_length(description) <= 280),
  event_key text check (event_key is null or char_length(event_key) <= 160),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists reader_activity_events_dedupe_idx
  on public.reader_activity_events (user_id, event_key)
  where event_key is not null;

create index if not exists reader_activity_events_user_time_idx
  on public.reader_activity_events (user_id, occurred_at desc, id desc);

create index if not exists reader_activity_events_retention_idx
  on public.reader_activity_events (occurred_at);

create table if not exists public.reader_activity_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  period text not null check (period in ('day', 'week', 'month')),
  period_start timestamptz not null,
  category text not null check (category in ('interactions', 'reading', 'transactions', 'security')),
  action text not null check (char_length(action) between 2 and 64),
  event_count integer not null default 1 check (event_count > 0),
  first_at timestamptz not null,
  last_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint reader_activity_summary_times_check check (first_at <= last_at),
  constraint reader_activity_summary_group_unique
    unique (user_id, period, period_start, category, action)
);

create index if not exists reader_activity_summaries_user_time_idx
  on public.reader_activity_summaries (user_id, period_start desc, id desc);

create index if not exists reader_activity_summaries_retention_idx
  on public.reader_activity_summaries (period_start);

alter table public.reader_activity_events enable row level security;
alter table public.reader_activity_summaries enable row level security;

revoke all on public.reader_activity_events from public, anon, authenticated;
revoke all on public.reader_activity_summaries from public, anon, authenticated;

grant select, insert, update, delete on public.reader_activity_events to service_role;
grant select, insert, update, delete on public.reader_activity_summaries to service_role;

commit;
