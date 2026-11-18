create table if not exists public.system_usage_archives (
  archive_key text primary key check (archive_key ~ '^[0-9a-f]{64}$'),
  bucket text not null default 'shadow-system-usage-archives',
  object_path text not null unique,
  window_from timestamptz not null,
  window_to timestamptz not null,
  source_kind text not null,
  source_complete boolean not null default false,
  source_rows bigint not null check (source_rows >= 0),
  group_count bigint not null check (group_count >= 0),
  totals jsonb not null default '{}'::jsonb,
  coverage jsonb not null default '{}'::jsonb,
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  constraint system_usage_archives_window_check check (window_from < window_to),
  constraint system_usage_archives_bucket_check check (bucket = 'shadow-system-usage-archives')
);

create index if not exists system_usage_archives_window_idx
  on public.system_usage_archives (window_from, window_to);

create index if not exists system_usage_archives_created_idx
  on public.system_usage_archives (created_at desc);

alter table public.system_usage_archives enable row level security;
revoke all on public.system_usage_archives from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'shadow-system-usage-archives',
  'shadow-system-usage-archives',
  false,
  20971520,
  array['application/gzip']::text[]
)
on conflict (id) do nothing;
