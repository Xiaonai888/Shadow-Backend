create table if not exists public.reader_tag_mention_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  tags text not null default 'everyone' check (tags in ('everyone', 'following', 'nobody')),
  mentions text not null default 'everyone' check (mentions in ('everyone', 'following', 'nobody')),
  review_tags boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.reader_tag_mention_settings enable row level security;
revoke all on table public.reader_tag_mention_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.reader_tag_mention_settings to service_role;
