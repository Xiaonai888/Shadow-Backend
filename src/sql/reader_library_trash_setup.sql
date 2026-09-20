create table if not exists public.reader_library_trash (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  story_id uuid not null references public.stories(id) on delete cascade,
  originally_saved_at timestamptz,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  constraint reader_library_trash_unique_story unique (user_id, story_id),
  constraint reader_library_trash_valid_expiry check (expires_at > deleted_at)
);

create index if not exists reader_library_trash_user_deleted_idx
  on public.reader_library_trash (user_id, deleted_at desc);

create index if not exists reader_library_trash_expires_idx
  on public.reader_library_trash (expires_at);

alter table public.reader_library_trash enable row level security;

revoke all on table public.reader_library_trash from anon, authenticated;
