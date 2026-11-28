begin;

create table if not exists public.telegram_promotion_v2_slot_tracking (
  language text primary key references public.telegram_promotion_settings(language) check (language in ('km','en')),
  tracked_from timestamptz not null,
  seeded_through date,
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_promotion_v2_slot_jobs (
  language text not null references public.telegram_promotion_settings(language) check (language in ('km','en')),
  slot_key text not null check (slot_key ~ '^\d{4}-\d{2}-\d{2}T(11|18|21):00$'),
  due_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','processing','retrying','queued','sent','skipped','uncertain','missed','failed')),
  attempts integer not null default 0 check (attempts between 0 and 32),
  next_attempt_at timestamptz,
  claim_id uuid,
  lease_until timestamptz,
  queue_id uuid references public.telegram_promotion_queue(id) on delete set null,
  last_reason text check (char_length(last_reason)<=500),
  deadline_checked_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(language,slot_key),
  unique(queue_id),
  check (slot_key=to_char(due_at at time zone 'Asia/Phnom_Penh','YYYY-MM-DD"T"HH24:MI')),
  check (expires_at=due_at+interval '3 hours'),
  check ((status='processing')=(claim_id is not null and lease_until is not null)),
  check ((status in ('sent','skipped','uncertain','missed','failed'))=(finished_at is not null)),
  check ((status in ('pending','processing','retrying','queued'))=(next_attempt_at is not null))
);

create index if not exists telegram_promotion_v2_slot_jobs_due_idx on public.telegram_promotion_v2_slot_jobs(language,next_attempt_at) where status in ('pending','processing','retrying','queued');
create index if not exists telegram_promotion_v2_slot_jobs_deadline_idx on public.telegram_promotion_v2_slot_jobs(language,due_at) where deadline_checked_at is not null;

alter table public.telegram_promotion_v2_slot_tracking enable row level security;
alter table public.telegram_promotion_v2_slot_jobs enable row level security;
revoke all on public.telegram_promotion_v2_slot_tracking,public.telegram_promotion_v2_slot_jobs from public,anon,authenticated;
grant select,insert,update on public.telegram_promotion_v2_slot_tracking,public.telegram_promotion_v2_slot_jobs to service_role;

commit;
