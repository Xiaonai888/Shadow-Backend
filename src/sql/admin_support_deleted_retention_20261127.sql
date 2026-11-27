begin;

alter table public.admin_support_messages
  drop constraint admin_support_message_content,
  add constraint admin_support_message_content check (
    deleted_at is not null
    or (message_text is not null and char_length(btrim(message_text)) between 1 and 10000)
    or jsonb_array_length(attachments) > 0
  );

create table if not exists public.admin_support_deleted_reader_content (
  message_id uuid primary key references public.admin_support_messages(id) on delete cascade,
  conversation_id uuid not null references public.admin_support_conversations(id) on delete cascade,
  deleted_at timestamptz not null,
  expires_at timestamptz not null,
  message_text text,
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  check (expires_at = deleted_at + interval '720 hours')
);

create index if not exists admin_support_deleted_reader_expiry_idx
  on public.admin_support_deleted_reader_content (expires_at, message_id);
create index if not exists admin_support_deleted_reader_chat_idx
  on public.admin_support_deleted_reader_content (conversation_id, message_id);

create table if not exists public.admin_support_deleted_media_queue (
  storage_key text primary key check (storage_key ~ '^support-chat-media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(webp|jpg|png)$'),
  queued_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now()
);
create index if not exists admin_support_deleted_media_due_idx
  on public.admin_support_deleted_media_queue (next_attempt_at, storage_key);
create index if not exists admin_support_deleted_unprocessed_idx
  on public.admin_support_messages (deleted_at, id)
  where deleted_at is not null and (message_text is not null or attachments <> '[]'::jsonb);

alter table public.admin_support_deleted_reader_content enable row level security;
alter table public.admin_support_deleted_media_queue enable row level security;
revoke all on public.admin_support_deleted_reader_content, public.admin_support_deleted_media_queue from public, anon, authenticated;
grant select, insert, update, delete on public.admin_support_deleted_reader_content, public.admin_support_deleted_media_queue to service_role;

create or replace function public.queue_deleted_support_media_v1(p_attachments jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.admin_support_deleted_media_queue (storage_key)
  select distinct item->>'storage_key'
  from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) as entries(item)
  where item->>'type' = 'image'
    and item->>'storage_key' ~ '^support-chat-media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(webp|jpg|png)$'
  on conflict (storage_key) do nothing;
$$;

create or replace function public.retain_deleted_support_message_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.deleted_at is null or (old.message_text is null and old.attachments = '[]'::jsonb) then
    return new;
  end if;

  if old.sender_kind = 'reader' and new.deleted_at + interval '720 hours' > now() then
    insert into public.admin_support_deleted_reader_content (
      message_id, conversation_id, deleted_at, expires_at, message_text, attachments
    ) values (
      old.id, old.conversation_id, new.deleted_at,
      new.deleted_at + interval '720 hours', old.message_text, old.attachments
    ) on conflict (message_id) do nothing;
  else
    perform public.queue_deleted_support_media_v1(old.attachments);
  end if;

  new.message_text := null;
  new.attachments := '[]'::jsonb;
  return new;
end;
$$;

drop trigger if exists admin_support_retain_deleted_message_trigger on public.admin_support_messages;
create trigger admin_support_retain_deleted_message_trigger
before update of deleted_at on public.admin_support_messages
for each row when (new.deleted_at is not null)
execute function public.retain_deleted_support_message_v1();

create or replace function public.queue_expired_support_media_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.queue_deleted_support_media_v1(old.attachments);
  return old;
end;
$$;

drop trigger if exists admin_support_queue_expired_media_trigger on public.admin_support_deleted_reader_content;
create trigger admin_support_queue_expired_media_trigger
before delete on public.admin_support_deleted_reader_content
for each row execute function public.queue_expired_support_media_v1();

create or replace function public.cleanup_deleted_support_content_v1(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_migrated integer := 0;
  v_expired integer := 0;
begin
  with candidates as (
    select id from public.admin_support_messages
    where deleted_at is not null and (message_text is not null or attachments <> '[]'::jsonb)
    order by deleted_at, id limit v_limit for update skip locked
  )
  update public.admin_support_messages m set deleted_at = m.deleted_at
  from candidates c where m.id = c.id;
  get diagnostics v_migrated = row_count;

  with candidates as (
    select message_id from public.admin_support_deleted_reader_content
    where expires_at <= now()
    order by expires_at, message_id limit v_limit for update skip locked
  )
  delete from public.admin_support_deleted_reader_content r
  using candidates c where r.message_id = c.message_id;
  get diagnostics v_expired = row_count;

  return jsonb_build_object('migrated', v_migrated, 'expired', v_expired);
end;
$$;

create or replace function public.claim_deleted_support_media_v1(p_limit integer default 20)
returns table(storage_key text)
language sql
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select q.storage_key from public.admin_support_deleted_media_queue q
    where q.next_attempt_at <= now()
    order by q.next_attempt_at, q.storage_key
    limit greatest(1, least(coalesce(p_limit, 20), 20)) for update skip locked
  )
  update public.admin_support_deleted_media_queue q
  set next_attempt_at = now() + interval '24 hours'
  from candidates c where q.storage_key = c.storage_key
  returning q.storage_key;
$$;

revoke all on function public.queue_deleted_support_media_v1(jsonb) from public, anon, authenticated;
revoke all on function public.retain_deleted_support_message_v1() from public, anon, authenticated;
revoke all on function public.queue_expired_support_media_v1() from public, anon, authenticated;
revoke all on function public.cleanup_deleted_support_content_v1(integer) from public, anon, authenticated;
revoke all on function public.claim_deleted_support_media_v1(integer) from public, anon, authenticated;
grant execute on function public.cleanup_deleted_support_content_v1(integer) to service_role;
grant execute on function public.claim_deleted_support_media_v1(integer) to service_role;

commit;
