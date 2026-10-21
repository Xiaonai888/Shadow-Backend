begin;

create table if not exists public.reader_comment_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  audience text not null default 'everyone' check (audience in ('everyone', 'followers', 'following')),
  allow_comments boolean not null default true,
  filter_spam boolean not null default true,
  comment_approval boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.reader_comment_settings enable row level security;

revoke all on public.reader_comment_settings from public, anon, authenticated;
grant select, insert, update on public.reader_comment_settings to service_role;

commit;
