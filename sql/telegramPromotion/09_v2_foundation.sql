begin;

create table if not exists public.telegram_promotion_v2_message_meta (
  queue_id uuid primary key references public.telegram_promotion_queue(id) on delete cascade,
  post_type text not null check (post_type in ('update','solo','group')),
  topic text check (topic in ('gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','similar','night','author')),
  caption_id text check (caption_id is null or length(caption_id) between 1 and 200),
  telegram_message_ids bigint[] not null default '{}'::bigint[] check (cardinality(telegram_message_ids)<=5 and array_position(telegram_message_ids,null::bigint) is null and 0<all(telegram_message_ids)),
  telegram_media_group_id text check (telegram_media_group_id is null or length(telegram_media_group_id) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (post_type<>'group' or (topic is not null and caption_id is not null))
);

create table if not exists public.telegram_promotion_v2_group_stories (
  queue_id uuid not null references public.telegram_promotion_v2_message_meta(queue_id) on delete cascade,
  story_id uuid not null,
  episode_id uuid not null,
  position smallint not null check (position between 1 and 5),
  primary key(queue_id,story_id),
  unique(queue_id,position)
);

create index if not exists telegram_promotion_v2_group_story_idx on public.telegram_promotion_v2_group_stories(story_id,queue_id);

create table if not exists public.telegram_promotion_v2_update_groups (
  language text not null references public.telegram_promotion_settings(language),
  story_id uuid not null,
  local_day date not null,
  group_no smallint not null check (group_no between 1 and 3),
  queue_id uuid not null unique references public.telegram_promotion_queue(id) on delete cascade,
  first_episode_id uuid not null,
  first_published_at timestamptz not null,
  desired_revision integer not null default 1 check (desired_revision>=1),
  applied_revision integer not null default 0 check (applied_revision>=0),
  next_edit_at timestamptz,
  edit_attempts integer not null default 0 check (edit_attempts between 0 and 5),
  edit_lease_until timestamptz,
  last_edit_error text check (last_edit_error is null or length(last_edit_error)<=500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(language,story_id,local_day,group_no),
  unique(language,first_episode_id),
  check (applied_revision<=desired_revision),
  check (local_day=(first_published_at at time zone 'Asia/Phnom_Penh')::date)
);

create index if not exists telegram_promotion_v2_update_edit_idx on public.telegram_promotion_v2_update_groups(language,next_edit_at) where applied_revision<desired_revision and next_edit_at is not null;

create table if not exists public.telegram_promotion_v2_update_episodes (
  language text not null,
  episode_id uuid not null,
  story_id uuid not null,
  local_day date not null,
  group_no smallint not null,
  first_published_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(language,episode_id),
  foreign key(language,story_id,local_day,group_no) references public.telegram_promotion_v2_update_groups(language,story_id,local_day,group_no) on delete cascade,
  check (local_day=(first_published_at at time zone 'Asia/Phnom_Penh')::date)
);

create index if not exists telegram_promotion_v2_update_episode_group_idx on public.telegram_promotion_v2_update_episodes(language,story_id,local_day,group_no,first_published_at);

alter table public.telegram_promotion_v2_message_meta enable row level security;
alter table public.telegram_promotion_v2_group_stories enable row level security;
alter table public.telegram_promotion_v2_update_groups enable row level security;
alter table public.telegram_promotion_v2_update_episodes enable row level security;

revoke all on public.telegram_promotion_v2_message_meta,public.telegram_promotion_v2_group_stories,public.telegram_promotion_v2_update_groups,public.telegram_promotion_v2_update_episodes from public,anon,authenticated;
grant select,insert,update,delete on public.telegram_promotion_v2_message_meta,public.telegram_promotion_v2_group_stories,public.telegram_promotion_v2_update_groups,public.telegram_promotion_v2_update_episodes to service_role;

commit;
