begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.admin_support_conversations
  add column if not exists last_reader_message_at timestamptz;

create or replace function public.admin_support_touch_reader_notification_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update public.admin_support_conversations
  set last_reader_message_at = new.created_at
  where id = new.conversation_id
    and (last_reader_message_at is null or last_reader_message_at < new.created_at);
  return new;
end;
$$;

revoke all on function public.admin_support_touch_reader_notification_v1() from public, anon, authenticated;
grant execute on function public.admin_support_touch_reader_notification_v1() to service_role;

drop trigger if exists admin_support_touch_reader_notification_v1 on public.admin_support_messages;
create trigger admin_support_touch_reader_notification_v1
after insert on public.admin_support_messages
for each row when (new.sender_kind = 'reader')
execute function public.admin_support_touch_reader_notification_v1();

update public.admin_support_conversations c
set last_reader_message_at = m.latest
from (
  select conversation_id, max(created_at) as latest
  from public.admin_support_messages
  where sender_kind = 'reader'
  group by conversation_id
) m
where c.id = m.conversation_id
  and (c.last_reader_message_at is null or c.last_reader_message_at < m.latest);

create index if not exists admin_support_notification_history_idx
  on public.admin_support_conversations (last_reader_message_at desc nulls last, created_at desc, id desc)
  where status <> 'archived' and last_reader_message_at is not null;

create index if not exists admin_support_notification_staff_history_idx
  on public.admin_support_conversations (assigned_admin_id, last_reader_message_at desc nulls last, created_at desc, id desc)
  where status <> 'archived' and last_reader_message_at is not null;

commit;
