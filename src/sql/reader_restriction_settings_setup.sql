begin;

create table if not exists public.reader_restriction_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  hide_comments boolean not null default false,
  filter_messages boolean not null default false,
  hide_activity_status boolean not null default false,
  mute_mentions boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.reader_restriction_settings enable row level security;

revoke all on public.reader_restriction_settings from public, anon, authenticated;
grant select, insert, update on public.reader_restriction_settings to service_role;

commit;
