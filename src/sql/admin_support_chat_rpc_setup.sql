create or replace function public.admin_support_send_message_v1(
  p_reader_user_id uuid,
  p_sender_kind text,
  p_sender_admin_id text,
  p_public_support_id text,
  p_message_text text,
  p_message_id uuid,
  p_conversation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conversation public.admin_support_conversations%rowtype;
  v_message public.admin_support_messages%rowtype;
  v_text text := btrim(coalesce(p_message_text, ''));
  v_created boolean := false;
  v_admin_role text;
  v_now timestamptz := now();
begin
  if p_reader_user_id is null or p_message_id is null
    or p_sender_kind not in ('reader', 'admin')
    or char_length(v_text) < 1 or char_length(v_text) > 2000 then
    raise exception 'Invalid support message input';
  end if;

  if p_sender_kind = 'reader' then
    if p_sender_admin_id is not null or p_public_support_id is not null then
      raise exception 'Reader sender must not specify an admin identity';
    end if;
  elsif char_length(btrim(coalesce(p_sender_admin_id, ''))) < 1
    or char_length(btrim(coalesce(p_public_support_id, ''))) < 1
    or char_length(p_public_support_id) > 40 then
    raise exception 'Admin sender identity required';
  end if;

  if not exists (
    select 1 from public.users
    where id = p_reader_user_id and is_active = true
  ) then
    raise exception 'Reader account is unavailable';
  end if;

  if p_conversation_id is null then
    insert into public.admin_support_conversations (reader_user_id)
    values (p_reader_user_id)
    on conflict (reader_user_id) do nothing;
  end if;

  select * into v_conversation
  from public.admin_support_conversations
  where reader_user_id = p_reader_user_id
    and (p_conversation_id is null or id = p_conversation_id)
  for update;

  if not found then
    raise exception 'Support conversation not found';
  end if;

  if v_conversation.status = 'archived' then
    raise exception 'Archived support conversation must be restored before messaging';
  end if;

  if p_sender_kind = 'admin' then
    select lower(role) into v_admin_role
    from public.admin_users
    where id::text = p_sender_admin_id and lower(coalesce(status, 'active')) = 'active';
    if v_admin_role not in ('owner', 'admin', 'staff') or v_admin_role is null then
      raise exception 'Admin account is unavailable';
    end if;
    if v_admin_role = 'staff'
      and v_conversation.assigned_admin_id is distinct from p_sender_admin_id then
      raise exception 'Staff is not assigned to this conversation';
    end if;
  end if;

  select * into v_message from public.admin_support_messages
  where id = p_message_id;

  if found then
    if v_message.conversation_id <> v_conversation.id
      or v_message.sender_kind <> p_sender_kind
      or v_message.message_text is distinct from v_text
      or (p_sender_kind = 'admin'
        and v_message.sender_admin_id is distinct from p_sender_admin_id) then
      raise exception 'Support message request ID already belongs to another message';
    end if;
  else
    insert into public.admin_support_messages (
      id, conversation_id, sender_kind, sender_admin_id,
      public_support_id, message_text, created_at
    ) values (
      p_message_id, v_conversation.id, p_sender_kind,
      case when p_sender_kind = 'admin' then p_sender_admin_id else null end,
      case when p_sender_kind = 'admin' then p_public_support_id else null end,
      v_text, v_now
    ) returning * into v_message;
    v_created := true;

    update public.admin_support_conversations
    set last_message_at = v_message.created_at,
        last_message_preview = left(v_text, 500),
        unread_for_admin = unread_for_admin + case when p_sender_kind = 'reader' then 1 else 0 end,
        unread_for_reader = unread_for_reader + case when p_sender_kind = 'admin' then 1 else 0 end
    where id = v_conversation.id
      and (last_message_at is null or last_message_at <= v_message.created_at);

    if p_sender_kind = 'admin' then
      insert into public.admin_support_activity (
        conversation_id, conversation_ref, admin_id, action, details
      ) values (
        v_conversation.id, v_conversation.id, p_sender_admin_id,
        'reply', jsonb_build_object('message_id', p_message_id)
      );
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'created', v_created,
    'conversation_id', v_conversation.id,
    'message', jsonb_build_object(
      'id', v_message.id,
      'conversation_id', v_message.conversation_id,
      'sender_kind', v_message.sender_kind,
      'public_support_id', v_message.public_support_id,
      'message_text', v_message.message_text,
      'created_at', v_message.created_at
    )
  );
end;
$$;

create or replace function public.admin_support_update_conversation_v1(
  p_conversation_id uuid,
  p_admin_id text,
  p_action text,
  p_value text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.admin_support_conversations%rowtype;
  v_value text := btrim(coalesce(p_value, ''));
  v_old text;
  v_new text;
  v_admin_role text;
begin
  if p_conversation_id is null or char_length(btrim(coalesce(p_admin_id, ''))) < 1 then
    raise exception 'Invalid support conversation action';
  end if;

  select * into v_row from public.admin_support_conversations
  where id = p_conversation_id for update;
  if not found then raise exception 'Support conversation not found'; end if;

  select lower(role) into v_admin_role from public.admin_users
  where id::text = p_admin_id and lower(coalesce(status, 'active')) = 'active';
  if v_admin_role not in ('owner', 'admin', 'staff') or v_admin_role is null then
    raise exception 'Admin account is unavailable';
  end if;
  if v_admin_role = 'staff'
    and (p_action in ('assign', 'archive', 'restore')
      or v_row.assigned_admin_id is distinct from p_admin_id) then
    raise exception 'Staff may update only their assigned active conversations';
  end if;

  if p_action = 'read' then
    v_old := v_row.unread_for_admin::text;
    update public.admin_support_conversations set unread_for_admin = 0
    where id = p_conversation_id;
    v_new := '0';
  elsif p_action = 'archive' then
    if v_row.status = 'archived' then raise exception 'Conversation already archived'; end if;
    v_old := v_row.status;
    update public.admin_support_conversations
    set status = 'archived', archived_at = now(), archived_by_admin_id = p_admin_id
    where id = p_conversation_id;
    v_new := 'archived';
  elsif p_action = 'restore' then
    if v_row.status <> 'archived' then raise exception 'Conversation is not archived'; end if;
    v_old := 'archived';
    update public.admin_support_conversations
    set status = 'open', archived_at = null, archived_by_admin_id = null
    where id = p_conversation_id;
    v_new := 'open';
  elsif p_action = 'priority' then
    if v_row.status = 'archived' then raise exception 'Archived conversation is read only'; end if;
    if v_value not in ('normal', 'high', 'urgent') then raise exception 'Invalid priority'; end if;
    v_old := v_row.priority;
    update public.admin_support_conversations set priority = v_value
    where id = p_conversation_id;
    v_new := v_value;
  elsif p_action = 'assign' then
    if v_row.status = 'archived' then raise exception 'Archived conversation is read only'; end if;
    if v_value <> '' and not exists (
      select 1 from public.admin_users where id::text = v_value
        and lower(coalesce(status, 'active')) = 'active'
    ) then raise exception 'Assigned Admin was not found'; end if;
    v_old := coalesce(v_row.assigned_admin_id, '');
    update public.admin_support_conversations
    set assigned_admin_id = nullif(v_value, ''), assigned_mode = 'manual'
    where id = p_conversation_id;
    v_new := v_value;
  elsif p_action = 'country' then
    if v_row.status = 'archived' then raise exception 'Archived conversation is read only'; end if;
    if v_value <> '' and v_value !~ '^[A-Z]{2}$' then raise exception 'Invalid country code'; end if;
    v_old := coalesce(v_row.override_country_code, '');
    update public.admin_support_conversations
    set override_country_code = nullif(v_value, '') where id = p_conversation_id;
    v_new := v_value;
  elsif p_action = 'note' then
    if v_row.status = 'archived' then raise exception 'Archived conversation is read only'; end if;
    if char_length(coalesce(p_value, '')) > 10000 then raise exception 'Note is too long'; end if;
    v_old := coalesce(v_row.internal_notes, '');
    update public.admin_support_conversations
    set internal_notes = coalesce(p_value, '') where id = p_conversation_id;
    v_new := coalesce(p_value, '');
  else
    raise exception 'Unsupported support conversation action';
  end if;

  if v_old is distinct from v_new then
    insert into public.admin_support_activity (
      conversation_id, conversation_ref, admin_id, action, details
    ) values (
      p_conversation_id, p_conversation_id, p_admin_id, p_action,
      case when p_action = 'note' then jsonb_build_object('changed', true)
        else jsonb_build_object('from', v_old, 'to', v_new) end
    );
  end if;

  return jsonb_build_object('ok', true, 'conversation_id', p_conversation_id, 'action', p_action);
end;
$$;

revoke all on function public.admin_support_send_message_v1(uuid, text, text, text, text, uuid, uuid)
from public, anon, authenticated;
revoke all on function public.admin_support_update_conversation_v1(uuid, text, text, text)
from public, anon, authenticated;
grant execute on function public.admin_support_send_message_v1(uuid, text, text, text, text, uuid, uuid)
to service_role;
grant execute on function public.admin_support_update_conversation_v1(uuid, text, text, text)
to service_role;
