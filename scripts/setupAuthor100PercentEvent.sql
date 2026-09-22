create table if not exists public.author_100_percent_event_cycles (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.author_pages(id) on delete restrict,
  author_name_at_grant text not null default '',
  duration_seconds bigint not null default 31536000,
  remaining_seconds bigint not null default 31536000,
  used_seconds bigint not null default 0,
  status text not null default 'paused',
  scheduled_start_at timestamptz,
  first_started_at timestamptz,
  last_resumed_at timestamptz,
  last_paused_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint author_100_percent_duration_check check (
    duration_seconds > 0 and duration_seconds <= 315360000
  ),
  constraint author_100_percent_remaining_check check (
    remaining_seconds >= 0 and used_seconds >= 0
    and remaining_seconds + used_seconds = duration_seconds
  ),
  constraint author_100_percent_status_check check (
    status in ('scheduled', 'active', 'paused', 'completed')
  ),
  constraint author_100_percent_active_check check (
    status <> 'active' or last_resumed_at is not null
  ),
  constraint author_100_percent_completed_check check (
    status <> 'completed' or (remaining_seconds = 0 and completed_at is not null)
  )
);

create unique index if not exists author_100_percent_one_open_cycle_idx
  on public.author_100_percent_event_cycles(author_id)
  where status in ('scheduled', 'active', 'paused');

create index if not exists author_100_percent_author_history_idx
  on public.author_100_percent_event_cycles(author_id, created_at desc);

create table if not exists public.author_100_percent_event_history (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.author_100_percent_event_cycles(id) on delete restrict,
  author_id uuid not null,
  author_name_snapshot text not null default '',
  admin_id text not null,
  admin_email text not null default '',
  action text not null,
  status_before text,
  status_after text,
  seconds_remaining_before bigint,
  seconds_remaining_after bigint,
  passkey_verified boolean not null default false,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint author_100_percent_history_action_check check (
    action in ('add', 'remove', 'resume', 'complete', 'regrant', 'update')
  ),
  constraint author_100_percent_history_seconds_check check (
    (seconds_remaining_before is null or seconds_remaining_before >= 0)
    and (seconds_remaining_after is null or seconds_remaining_after >= 0)
  )
);

create index if not exists author_100_percent_history_author_idx
  on public.author_100_percent_event_history(author_id, created_at desc);

create index if not exists author_100_percent_history_cycle_idx
  on public.author_100_percent_event_history(cycle_id, created_at desc);

alter table public.author_100_percent_event_cycles enable row level security;
alter table public.author_100_percent_event_history enable row level security;

revoke all on public.author_100_percent_event_cycles from anon, authenticated;
revoke all on public.author_100_percent_event_history from anon, authenticated;
grant select, insert, update, delete on public.author_100_percent_event_cycles to service_role;
grant select, insert on public.author_100_percent_event_history to service_role;
