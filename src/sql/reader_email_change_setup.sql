alter table public.users
add column if not exists email_changed_at timestamptz;

create table if not exists public.email_change_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.users(id)
    on delete cascade,
  new_email text not null,
  token_hash text not null,
  expires_at timestamptz not null,
  attempt_count integer not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint email_change_tokens_attempt_count_check
    check (attempt_count >= 0)
);

create index if not exists
email_change_tokens_user_created_idx
on public.email_change_tokens (
  user_id,
  created_at desc
);

create index if not exists
email_change_tokens_new_email_idx
on public.email_change_tokens (
  lower(new_email)
);

alter table public.email_change_tokens
enable row level security;

revoke all
on public.email_change_tokens
from public, anon, authenticated;

grant all
on public.email_change_tokens
to service_role;
