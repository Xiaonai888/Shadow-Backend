create table if not exists public.admin_support_conversations (
  id uuid primary key default gen_random_uuid(),
  reader_user_id uuid not null unique references public.users(id),
  status text not null default 'open' check (status in ('open', 'pending', 'resolved', 'archived')),
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  detected_country_code text check (detected_country_code ~ '^[A-Z]{2}$'),
  override_country_code text check (override_country_code ~ '^[A-Z]{2}$'),
  assigned_admin_id text,
  assigned_mode text not null default 'manual' check (assigned_mode in ('manual', 'auto')),
  last_message_at timestamptz,
  last_message_preview text,
  unread_for_admin integer not null default 0 check (unread_for_admin >= 0),
  unread_for_reader integer not null default 0 check (unread_for_reader >= 0),
  internal_notes text not null default '',
  archived_at timestamptz,
  archived_by_admin_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_support_preview_length check (char_length(coalesce(last_message_preview, '')) <= 500),
  constraint admin_support_notes_length check (char_length(internal_notes) <= 10000)
);

create table if not exists public.admin_support_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.admin_support_conversations(id) on delete cascade,
  sender_kind text not null check (sender_kind in ('reader', 'admin', 'system')),
  sender_admin_id text,
  public_support_id text,
  message_text text,
  attachments jsonb not null default '[]'::jsonb,
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  constraint admin_support_attachments_array check (jsonb_typeof(attachments) = 'array'),
  constraint admin_support_message_content check (
    (message_text is not null and char_length(btrim(message_text)) between 1 and 10000)
    or jsonb_array_length(attachments) > 0
  ),
  constraint admin_support_sender_identity check (
    (sender_kind = 'admin' and nullif(btrim(coalesce(sender_admin_id, '')), '') is not null)
    or (sender_kind in ('reader', 'system') and sender_admin_id is null)
  )
);

create table if not exists public.admin_support_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_by_admin_id text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_support_folder_members (
  conversation_id uuid not null references public.admin_support_conversations(id) on delete cascade,
  folder_id uuid not null references public.admin_support_folders(id) on delete cascade,
  added_by_admin_id text not null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, folder_id)
);

create table if not exists public.admin_support_activity (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.admin_support_conversations(id) on delete set null,
  conversation_ref uuid not null,
  admin_id text not null,
  action text not null check (char_length(btrim(action)) between 1 and 80),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint admin_support_activity_details_object check (jsonb_typeof(details) = 'object')
);

create unique index if not exists admin_support_folders_name_uq
  on public.admin_support_folders (lower(btrim(name)));

create index if not exists admin_support_inbox_latest_idx
  on public.admin_support_conversations (last_message_at desc nulls last, created_at desc, id)
  where status <> 'archived';

create index if not exists admin_support_archive_latest_idx
  on public.admin_support_conversations (archived_at desc nulls last, id)
  where status = 'archived';

create index if not exists admin_support_assigned_idx
  on public.admin_support_conversations (assigned_admin_id, last_message_at desc nulls last);

create index if not exists admin_support_messages_recent_idx
  on public.admin_support_messages (conversation_id, created_at desc, id desc);

create index if not exists admin_support_folder_members_folder_idx
  on public.admin_support_folder_members (folder_id, created_at desc);

create index if not exists admin_support_activity_recent_idx
  on public.admin_support_activity (conversation_ref, created_at desc, id desc);

create or replace function public.touch_admin_support_conversation_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists admin_support_conversation_updated_at_trigger
  on public.admin_support_conversations;

create trigger admin_support_conversation_updated_at_trigger
before update on public.admin_support_conversations
for each row
execute function public.touch_admin_support_conversation_updated_at();

alter table public.admin_support_conversations enable row level security;
alter table public.admin_support_messages enable row level security;
alter table public.admin_support_folders enable row level security;
alter table public.admin_support_folder_members enable row level security;
alter table public.admin_support_activity enable row level security;

revoke all on public.admin_support_conversations from public, anon, authenticated;
revoke all on public.admin_support_messages from public, anon, authenticated;
revoke all on public.admin_support_folders from public, anon, authenticated;
revoke all on public.admin_support_folder_members from public, anon, authenticated;
revoke all on public.admin_support_activity from public, anon, authenticated;

grant select, insert, update, delete on public.admin_support_conversations to service_role;
grant select, insert, update, delete on public.admin_support_messages to service_role;
grant select, insert, update, delete on public.admin_support_folders to service_role;
grant select, insert, update, delete on public.admin_support_folder_members to service_role;
grant select, insert on public.admin_support_activity to service_role;

revoke all on function public.touch_admin_support_conversation_updated_at()
from public, anon, authenticated;
grant execute on function public.touch_admin_support_conversation_updated_at()
to service_role;
