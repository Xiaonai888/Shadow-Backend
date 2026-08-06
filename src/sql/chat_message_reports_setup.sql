create table if not exists public.chat_message_reports (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.chat_conversations(id)
    on delete cascade,
  message_id uuid not null
    references public.chat_messages(id)
    on delete cascade,
  reporter_user_id uuid not null
    references public.users(id)
    on delete cascade,
  reported_user_id uuid not null
    references public.users(id)
    on delete cascade,
  reason text not null,
  details text,
  status text not null default 'pending',
  reviewed_by_admin_id text,
  reviewed_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_message_reports_reason_check
    check (
      reason in (
        'spam',
        'harassment',
        'hate',
        'sexual_content',
        'violence',
        'scam',
        'impersonation',
        'privacy',
        'other'
      )
    ),
  constraint chat_message_reports_status_check
    check (
      status in (
        'pending',
        'reviewing',
        'resolved',
        'dismissed'
      )
    ),
  constraint chat_message_reports_not_self_check
    check (reporter_user_id <> reported_user_id),
  constraint chat_message_reports_unique
    unique (message_id, reporter_user_id)
);

create index if not exists
chat_message_reports_status_idx
on public.chat_message_reports (
  status,
  created_at desc
);

create index if not exists
chat_message_reports_conversation_idx
on public.chat_message_reports (
  conversation_id,
  created_at desc
);

create index if not exists
chat_message_reports_reported_user_idx
on public.chat_message_reports (
  reported_user_id,
  created_at desc
);

create or replace function
public.touch_chat_message_report_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists
touch_chat_message_report_updated_at_trigger
on public.chat_message_reports;

create trigger
touch_chat_message_report_updated_at_trigger
before update
on public.chat_message_reports
for each row
execute function
public.touch_chat_message_report_updated_at();

alter table public.chat_message_reports
enable row level security;

revoke all
on public.chat_message_reports
from public, anon, authenticated;

grant all
on public.chat_message_reports
to service_role;
