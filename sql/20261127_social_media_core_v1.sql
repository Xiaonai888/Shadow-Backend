begin;

create table if not exists public.social_media_connections (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('admin', 'author')),
  owner_id text not null check (char_length(owner_id) between 1 and 128),
  platform text not null check (platform = 'facebook'),
  external_id text not null check (external_id ~ '^[0-9]{1,40}$'),
  display_name text not null check (char_length(display_name) between 1 and 300),
  token_ciphertext text,
  token_expires_at timestamptz,
  status text not null default 'disabled' check (status in ('disabled', 'connected', 'reauth_required', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (owner_type <> 'admin' or owner_id = 'shadow'),
  check (status <> 'connected' or token_ciphertext is not null),
  check (status <> 'revoked' or token_ciphertext is null),
  unique (owner_type, owner_id, platform, external_id),
  unique (id, owner_type, owner_id)
);

create table if not exists public.social_promotion_rules (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null default 'admin' check (owner_type = 'admin'),
  owner_id text not null default 'shadow' check (owner_id = 'shadow'),
  connection_id uuid not null,
  name text not null check (char_length(name) between 1 and 160),
  enabled boolean not null default false,
  selection_mode text not null default 'stories' check (selection_mode in ('stories', 'authors', 'mixed')),
  story_ids text[] not null default '{}',
  author_ids text[] not null default '{}',
  content_mode text not null default 'short' check (content_mode in ('short', 'full', 'mixed')),
  daily_limit integer not null default 1 check (daily_limit between 1 and 100),
  publish_times time[] not null default '{}',
  timezone text not null default 'Asia/Phnom_Penh' check (timezone = 'Asia/Phnom_Penh'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(story_ids) <= 1000 and cardinality(author_ids) <= 1000),
  check (cardinality(publish_times) <= 100),
  check (not enabled or (cardinality(publish_times) > 0 and ((selection_mode = 'stories' and cardinality(story_ids) > 0) or (selection_mode = 'authors' and cardinality(author_ids) > 0) or (selection_mode = 'mixed' and (cardinality(story_ids) > 0 or cardinality(author_ids) > 0))))),
  foreign key (connection_id, owner_type, owner_id) references public.social_media_connections (id, owner_type, owner_id) on delete restrict,
  unique (id, connection_id, owner_type, owner_id)
);

create table if not exists public.social_media_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('admin', 'author')),
  owner_id text not null check (char_length(owner_id) between 1 and 128),
  connection_id uuid not null,
  rule_id uuid,
  story_id text not null check (char_length(story_id) between 1 and 128),
  episode_id text not null check (char_length(episode_id) between 1 and 128),
  content_mode text not null check (content_mode in ('short', 'full')),
  status text not null default 'queued' check (status in ('queued', 'publishing', 'published', 'failed', 'needs_review', 'cancelled')),
  scheduled_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  external_post_id text,
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,100}$'),
  created_at timestamptz not null default now(),
  check (owner_type <> 'admin' or owner_id = 'shadow'),
  check (owner_type = 'admin' or rule_id is null),
  check (status <> 'published' or external_post_id is not null),
  check ((status in ('queued', 'publishing') and finished_at is null) or (status not in ('queued', 'publishing') and finished_at is not null)),
  foreign key (connection_id, owner_type, owner_id) references public.social_media_connections (id, owner_type, owner_id) on delete restrict,
  foreign key (rule_id, connection_id, owner_type, owner_id) references public.social_promotion_rules (id, connection_id, owner_type, owner_id) on delete restrict,
  unique (connection_id, episode_id)
);

create index if not exists social_media_jobs_due_idx on public.social_media_jobs (scheduled_at, id) where status = 'queued';
create index if not exists social_media_jobs_owner_idx on public.social_media_jobs (owner_type, owner_id, created_at desc);
create index if not exists social_promotion_rules_connection_idx on public.social_promotion_rules (connection_id) where enabled;

alter table public.social_media_connections enable row level security;
alter table public.social_promotion_rules enable row level security;
alter table public.social_media_jobs enable row level security;
revoke all on public.social_media_connections, public.social_promotion_rules, public.social_media_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.social_media_connections, public.social_promotion_rules, public.social_media_jobs to service_role;

commit;
