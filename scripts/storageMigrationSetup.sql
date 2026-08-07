create table if not exists public.storage_migrations (
  migration_key text primary key,
  source_kind text not null check (source_kind in ('supabase_storage', 'inline_media')),
  old_bucket text,
  old_path text,
  old_url text,
  source_table text,
  source_row_id text,
  source_column text,
  r2_key text not null,
  r2_url text not null,
  file_size bigint not null check (file_size >= 0),
  checksum_sha256 text not null,
  migrated_at timestamptz not null default now(),
  verified_at timestamptz,
  delete_after timestamptz,
  deleted_at timestamptz,
  status text not null default 'verified' check (
    status in (
      'copied',
      'verified',
      'delete_pending',
      'deleted',
      'delete_failed',
      'blocked_active_reference',
      'blocked_r2_verification'
    )
  ),
  cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  last_cleanup_attempt_at timestamptz,
  last_cleanup_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists storage_migrations_source_object_unique
  on public.storage_migrations (old_bucket, old_path)
  where source_kind = 'supabase_storage'
    and old_bucket is not null
    and old_path is not null;

create index if not exists storage_migrations_cleanup_due_idx
  on public.storage_migrations (delete_after)
  where source_kind = 'supabase_storage'
    and verified_at is not null
    and deleted_at is null;

create index if not exists storage_migrations_status_idx
  on public.storage_migrations (status);

create index if not exists storage_migrations_r2_key_idx
  on public.storage_migrations (r2_key);

alter table public.storage_migrations enable row level security;

revoke all on table public.storage_migrations from anon;
revoke all on table public.storage_migrations from authenticated;

grant all on table public.storage_migrations to service_role;
