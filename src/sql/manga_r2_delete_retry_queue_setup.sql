create table if not exists public.manga_r2_delete_retry_queue (
  id uuid primary key default gen_random_uuid(),
  image_url text not null unique,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  last_attempt_at timestamptz,
  next_retry_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists manga_r2_delete_retry_queue_next_retry_idx
  on public.manga_r2_delete_retry_queue (next_retry_at);

alter table public.manga_r2_delete_retry_queue enable row level security;
