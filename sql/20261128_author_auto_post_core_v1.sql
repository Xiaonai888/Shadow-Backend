begin;

create table if not exists public.author_auto_post_system (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  weekly_free_posts integer not null default 100 check (weekly_free_posts between 0 and 10000),
  package_credits integer not null default 1000 check (package_credits between 1 and 100000),
  package_diamonds integer not null default 100 check (package_diamonds between 1 and 100000),
  enabled_platforms text[] not null default array['telegram','facebook','instagram','tiktok','threads']::text[] check (enabled_platforms <@ array['telegram','facebook','instagram','tiktok','threads']::text[] and array_position(enabled_platforms,null) is null),
  updated_at timestamptz not null default now()
);
insert into public.author_auto_post_system(id) values(true) on conflict do nothing;

create table if not exists public.author_auto_post_settings (
  author_id uuid primary key,
  enabled boolean not null default false,
  header_text text not null default '' check (char_length(header_text)<=300),
  footer_text text not null default '' check (char_length(footer_text)<=300),
  content_percent smallint not null default 30 check (content_percent between 10 and 100 and content_percent%10=0),
  episode_filter text not null default 'all' check (episode_filter in ('all','locked','free')),
  selection_mode text not null default 'all' check (selection_mode in ('all','selected')),
  story_ids uuid[] not null default '{}' check (cardinality(story_ids)<=1000 and array_position(story_ids,null) is null),
  posting_mode text not null default 'update' check (posting_mode in ('update','promotion','both')),
  include_cover boolean not null default true,
  locked_content_confirmed boolean not null default false,
  suspended_at timestamptz,
  suspended_until timestamptz,
  suspension_reason text check (suspension_reason is null or char_length(suspension_reason) between 1 and 500),
  updated_at timestamptz not null default now(),
  check (selection_mode='all' or cardinality(story_ids)>0),
  check (content_percent<=30 or episode_filter='free' or locked_content_confirmed),
  check ((suspended_at is null and suspended_until is null and suspension_reason is null) or (suspended_at is not null and suspension_reason is not null and (suspended_until is null or suspended_until>suspended_at)))
);

create table if not exists public.author_auto_post_credit_balances (
  author_id uuid primary key,
  available bigint not null default 0 check (available>=0),
  reserved bigint not null default 0 check (reserved>=0),
  updated_at timestamptz not null default now()
);

create table if not exists public.author_auto_post_weekly_usage (
  author_id uuid not null,
  week_start date not null check (extract(isodow from week_start)=1),
  used integer not null default 0 check (used>=0),
  reserved integer not null default 0 check (reserved>=0),
  primary key(author_id,week_start)
);

create table if not exists public.author_auto_post_groups (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  story_id uuid not null,
  episode_id uuid not null,
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  posting_mode text not null check (posting_mode in ('update','promotion')),
  content_percent smallint not null check (content_percent between 10 and 100 and content_percent%10=0),
  header_text text not null check (char_length(header_text)<=300),
  footer_text text not null check (char_length(footer_text)<=300),
  include_cover boolean not null,
  settings_revision timestamptz not null,
  status text not null default 'queued' check (status in ('queued','publishing','published','partial','failed','cancelled','needs_review')),
  credit_source text not null check (credit_source in ('weekly','purchased')),
  credit_state text not null default 'reserved' check (credit_state in ('reserved','charged','released')),
  week_start date not null check (extract(isodow from week_start)=1),
  scheduled_at timestamptz not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(author_id,dedupe_key),
  unique(id,author_id)
);

create table if not exists public.author_auto_post_deliveries (
  group_id uuid not null,
  author_id uuid not null,
  platform text not null check (platform in ('telegram','facebook','instagram','tiktok','threads')),
  connection_id uuid not null,
  status text not null default 'queued' check (status in ('queued','publishing','published','failed','cancelled','needs_review')),
  attempts smallint not null default 0 check (attempts>=0),
  external_post_id text,
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,100}$'),
  updated_at timestamptz not null default now(),
  primary key(group_id,platform),
  foreign key(group_id,author_id) references public.author_auto_post_groups(id,author_id) on delete restrict,
  check (status<>'published' or external_post_id is not null)
);

create table if not exists public.author_auto_post_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  operation_key text not null check (char_length(operation_key) between 1 and 200),
  operation text not null check (operation in ('purchase','charge','adjustment','refund')),
  credit_delta bigint not null,
  diamonds_spent integer not null default 0 check (diamonds_spent>=0),
  group_id uuid,
  created_at timestamptz not null default now(),
  unique(author_id,operation_key),
  foreign key(group_id,author_id) references public.author_auto_post_groups(id,author_id) on delete restrict,
  check (operation<>'purchase' or (credit_delta>0 and diamonds_spent>0)),
  check (operation<>'charge' or (credit_delta=-1 and group_id is not null))
);

create table if not exists public.author_auto_post_admin_actions (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  admin_id text not null check (char_length(admin_id) between 1 and 128),
  action text not null check (action in ('suspend','resume','disconnect','pause_platform','resume_platform','adjust_credit')),
  reason text not null check (char_length(reason) between 1 and 500),
  details jsonb not null default '{}' check (jsonb_typeof(details)='object'),
  created_at timestamptz not null default now()
);

create index if not exists author_auto_post_groups_due_idx on public.author_auto_post_groups(scheduled_at,id) where status='queued';
create index if not exists author_auto_post_groups_history_idx on public.author_auto_post_groups(author_id,created_at desc,id desc);
create index if not exists author_auto_post_deliveries_connection_idx on public.author_auto_post_deliveries(connection_id) where status in ('queued','publishing');
create index if not exists author_auto_post_ledger_history_idx on public.author_auto_post_credit_ledger(author_id,created_at desc,id desc);
create unique index if not exists author_auto_post_single_charge_idx on public.author_auto_post_credit_ledger(group_id) where operation='charge';
create index if not exists author_auto_post_actions_history_idx on public.author_auto_post_admin_actions(author_id,created_at desc,id desc);

do $$
declare t text;
begin
  foreach t in array array['author_auto_post_system','author_auto_post_settings','author_auto_post_credit_balances','author_auto_post_weekly_usage','author_auto_post_groups','author_auto_post_deliveries','author_auto_post_credit_ledger','author_auto_post_admin_actions'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select, insert, update, delete on public.%I to service_role',t);
  end loop;
end;
$$;
commit;
