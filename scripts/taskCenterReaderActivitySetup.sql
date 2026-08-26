create table if not exists public.task_center_reader_daily_snapshots (
  activity_date date not null,
  user_id uuid not null,
  checkin_claimed boolean not null default false,
  checkin_source_key text check (
    checkin_source_key is null
    or checkin_source_key in ('daily_bonus', 'premium_auto_claim')
  ),
  streak_day smallint not null default 0 check (streak_day between 0 and 7),
  reading_seconds integer not null default 0 check (reading_seconds >= 0),
  reading_target_seconds integer not null default 1800 check (reading_target_seconds > 0),
  reading_percent smallint not null default 0 check (reading_percent between 0 and 100),
  mission_progress jsonb not null default '[]'::jsonb check (jsonb_typeof(mission_progress) = 'array'),
  missions_completed smallint not null default 0 check (missions_completed >= 0),
  missions_total smallint not null default 0 check (missions_total >= 0),
  all_completed boolean not null default false,
  last_activity_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (activity_date, user_id)
);

create index if not exists task_center_reader_snapshots_user_date_idx
  on public.task_center_reader_daily_snapshots (user_id, activity_date desc);

create index if not exists task_center_reader_snapshots_date_claim_idx
  on public.task_center_reader_daily_snapshots (activity_date, checkin_source_key);

create index if not exists task_center_reader_snapshots_date_completed_idx
  on public.task_center_reader_daily_snapshots (activity_date, all_completed);

create index if not exists task_center_reader_snapshots_last_activity_idx
  on public.task_center_reader_daily_snapshots (activity_date, last_activity_at desc);

create table if not exists public.task_center_daily_summaries (
  activity_date date primary key,
  active_readers integer not null default 0 check (active_readers >= 0),
  manual_claims integer not null default 0 check (manual_claims >= 0),
  premium_auto_claims integer not null default 0 check (premium_auto_claims >= 0),
  mission_starters integer not null default 0 check (mission_starters >= 0),
  all_completed_users integer not null default 0 check (all_completed_users >= 0),
  completion_rate numeric(5,2) not null default 0 check (completion_rate between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.task_center_reader_daily_snapshots enable row level security;
alter table public.task_center_daily_summaries enable row level security;

revoke all on table public.task_center_reader_daily_snapshots from anon;
revoke all on table public.task_center_reader_daily_snapshots from authenticated;
revoke all on table public.task_center_daily_summaries from anon;
revoke all on table public.task_center_daily_summaries from authenticated;

grant all on table public.task_center_reader_daily_snapshots to service_role;
grant all on table public.task_center_daily_summaries to service_role;
