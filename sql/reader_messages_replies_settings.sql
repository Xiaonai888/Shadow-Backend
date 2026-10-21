create table if not exists public.reader_messages_replies_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  message_audience text not null default 'everyone' check (message_audience in ('everyone', 'following', 'nobody')),
  message_requests boolean not null default true,
  reply_audience text not null default 'everyone' check (reply_audience in ('everyone', 'followers', 'nobody')),
  message_notifications boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.reader_messages_replies_settings enable row level security;
revoke all on table public.reader_messages_replies_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.reader_messages_replies_settings to service_role;
