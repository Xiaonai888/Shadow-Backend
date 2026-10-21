begin;

create table if not exists public.reader_tag_mention_links (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references public.reader_posts(id) on delete cascade,
  comment_id uuid references public.reader_post_comments(id) on delete cascade,
  actor_user_id uuid not null references public.users(id) on delete cascade,
  target_user_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('tag', 'mention')),
  status text not null check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint reader_tag_mention_links_one_source check (num_nonnulls(post_id, comment_id) = 1)
);

create unique index if not exists reader_tag_mention_links_post_unique
  on public.reader_tag_mention_links (post_id, target_user_id, kind)
  where post_id is not null;

create unique index if not exists reader_tag_mention_links_comment_unique
  on public.reader_tag_mention_links (comment_id, target_user_id, kind)
  where comment_id is not null;

create index if not exists reader_tag_mention_links_target_status_idx
  on public.reader_tag_mention_links (target_user_id, status, created_at desc);

create index if not exists reader_tag_mention_links_actor_created_idx
  on public.reader_tag_mention_links (actor_user_id, created_at desc);

alter table public.reader_tag_mention_links enable row level security;

revoke all on table public.reader_tag_mention_links from public, anon, authenticated;
grant select, insert, update, delete on table public.reader_tag_mention_links to service_role;

commit;
