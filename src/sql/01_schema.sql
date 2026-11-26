begin;

create table if not exists public.telegram_promotion_settings (
  language text primary key check (language in ('km','en','zh','ko','ja')),
  enabled boolean not null default false,
  channel_id text unique check (channel_id is null or channel_id ~ '^-100[0-9]+$'),
  gap_seconds integer not null default 300 check (gap_seconds between 60 and 3600),
  schedule jsonb not null default '[{"day":1,"time":"12:00","kind":"completed"},{"day":1,"time":"19:00","kind":"completed"},{"day":2,"time":"12:00","kind":"short"},{"day":2,"time":"19:00","kind":"short"},{"day":3,"time":"12:00","kind":"author"},{"day":4,"time":"12:00","kind":"completed"},{"day":4,"time":"19:00","kind":"completed"},{"day":5,"time":"12:00","kind":"short"},{"day":5,"time":"19:00","kind":"short"},{"day":6,"time":"12:00","kind":"author"},{"day":0,"time":"12:00","kind":"trending"},{"day":0,"time":"19:00","kind":"trending"}]'::jsonb check (jsonb_typeof(schedule) = 'array' and jsonb_array_length(schedule) <= 42),
  links jsonb not null default '{"register":"https://www.shadowerabook.site/register","install":"https://www.shadowerabook.site/install","tutorial":"https://youtu.be/gMUvBCkkPHQ?si=ZZKdPMcLuX6KzE2i"}'::jsonb check (jsonb_typeof(links) = 'object'),
  next_send_at timestamptz not null default '-infinity',
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  check (not enabled or (channel_id is not null and enabled_at is not null))
);

insert into public.telegram_promotion_settings(language) values ('km'),('en'),('zh'),('ko'),('ja') on conflict (language) do nothing;

create table if not exists public.telegram_promotion_queue (
  id uuid primary key default gen_random_uuid(),
  language text not null references public.telegram_promotion_settings(language),
  job_key text not null check (length(job_key) between 1 and 200),
  kind text not null check (kind in ('update','completed','short','trending','author')),
  story_id uuid not null,
  episode_id uuid not null,
  author_id uuid,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16000 and jsonb_typeof(payload->'caption') = 'string' and length(payload->>'caption') <= 1000 and jsonb_typeof(payload->'photo') = 'string' and jsonb_typeof(payload->'reply_markup') = 'object'),
  status text not null default 'ready' check (status in ('ready','sending','sent','failed','uncertain','cancelled')),
  due_at timestamptz not null default now(),
  expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 5),
  lease_expires_at timestamptz,
  sent_at timestamptz,
  telegram_chat_id text,
  telegram_message_id bigint,
  last_error text check (last_error is null or length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(language, job_key),
  check ((status = 'sending') = (lease_expires_at is not null)),
  check (status <> 'sent' or (sent_at is not null and telegram_message_id is not null and telegram_chat_id is not null)),
  check (kind <> 'update' or expires_at is null)
);

create index if not exists telegram_promotion_ready_idx on public.telegram_promotion_queue(language, due_at, created_at) where status = 'ready';
create index if not exists telegram_promotion_sending_idx on public.telegram_promotion_queue(language, lease_expires_at) where status = 'sending';
create index if not exists telegram_promotion_story_history_idx on public.telegram_promotion_queue(language, story_id, created_at desc);
create index if not exists telegram_promotion_author_history_idx on public.telegram_promotion_queue(language, author_id, created_at desc) where kind = 'author';
create unique index if not exists telegram_promotion_update_once_idx on public.telegram_promotion_queue(language, episode_id) where kind = 'update';

create table if not exists public.telegram_promotion_photo_cache (
  bot_key text not null check (bot_key ~ '^[0-9a-f]{64}$'),
  cover_key text not null check (cover_key ~ '^[0-9a-f]{64}$'),
  file_id text not null check (length(file_id) between 1 and 1024),
  updated_at timestamptz not null default now(),
  primary key(bot_key, cover_key)
);

alter table public.telegram_promotion_settings enable row level security;
alter table public.telegram_promotion_queue enable row level security;
alter table public.telegram_promotion_photo_cache enable row level security;
revoke all on public.telegram_promotion_settings, public.telegram_promotion_queue, public.telegram_promotion_photo_cache from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_promotion_settings, public.telegram_promotion_queue, public.telegram_promotion_photo_cache to service_role;

commit;
