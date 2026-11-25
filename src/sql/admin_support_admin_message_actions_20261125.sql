begin;

create or replace function public.admin_support_admin_message_action_v1(
  p_conversation_id uuid,
  p_admin_id text,
  p_message_id uuid,
  p_action text,
  p_message_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conversation public.admin_support_conversations%rowtype;
  v_message public.admin_support_messages%rowtype;
  v_admin_role text;
  v_text text := btrim(coalesce(p_message_text, ''));
  v_changed boolean := false;
begin
  if p_conversation_id is null or p_message_id is null or p_admin_id is null
    or p_action is null or p_action not in ('edit', 'delete') then
    raise exception 'Invalid support message action';
  end if;

  select * into v_conversation from public.admin_support_conversations
  where id = p_conversation_id for update;
  if not found then raise exception 'Support message not found'; end if;

  select lower(role) into v_admin_role from public.admin_users
  where id::text = p_admin_id and lower(coalesce(status, 'active')) = 'active';
  if v_admin_role is null or v_admin_role not in ('owner', 'admin', 'staff')
    or (v_admin_role = 'staff' and v_conversation.assigned_admin_id is distinct from p_admin_id) then
    raise exception 'Support message not found';
  end if;
  if v_conversation.status = 'archived' then raise exception 'Archived support chat is read only'; end if;

  select * into v_message from public.admin_support_messages
  where id = p_message_id and conversation_id = p_conversation_id
    and sender_kind = 'admin' and sender_admin_id = p_admin_id for update;
  if not found then raise exception 'Support message not found'; end if;

  if p_action = 'edit' then
    if v_message.deleted_at is not null then raise exception 'Deleted support message cannot be edited'; end if;
    if v_message.message_text is null or char_length(v_text) not between 1 and 2000 then
      raise exception 'Invalid support message text';
    end if;
    if v_message.message_text is distinct from v_text then
      update public.admin_support_messages set message_text = v_text, edited_at = now()
      where id = p_message_id returning * into v_message;
      v_changed := true;
    end if;
  elsif v_message.deleted_at is null then
    update public.admin_support_messages set deleted_at = now()
    where id = p_message_id returning * into v_message;
    v_changed := true;
  end if;

  if v_changed then
    if v_conversation.last_message_at = v_message.created_at and p_message_id = (
      select id from public.admin_support_messages where conversation_id = p_conversation_id
      order by created_at desc, id desc limit 1
    ) then
      update public.admin_support_conversations
      set last_message_preview = case when p_action = 'delete' then 'Message deleted' else left(v_text, 500) end
      where id = p_conversation_id;
    end if;
    insert into public.admin_support_activity (conversation_id, conversation_ref, admin_id, action, details)
    values (p_conversation_id, p_conversation_id, p_admin_id, 'message_' || p_action,
      jsonb_build_object('message_id', p_message_id));
  end if;

  return jsonb_build_object('ok', true, 'changed', v_changed, 'conversation_id', p_conversation_id,
    'message', jsonb_build_object('id', v_message.id, 'conversation_id', v_message.conversation_id,
      'sender_kind', v_message.sender_kind, 'sender_admin_id', v_message.sender_admin_id,
      'public_support_id', v_message.public_support_id,
      'message_text', case when v_message.deleted_at is null then v_message.message_text else null end,
      'attachments', case when v_message.deleted_at is null then v_message.attachments else '[]'::jsonb end,
      'created_at', v_message.created_at, 'edited_at', v_message.edited_at,
      'deleted_at', v_message.deleted_at, 'seen_at', v_message.seen_at,
      'reply_to_message_id', v_message.reply_to_message_id));
end;
$$;

create or replace function public.admin_support_admin_reply_v1(
  p_conversation_id uuid,
  p_admin_id text,
  p_public_support_id text,
  p_message_text text,
  p_message_id uuid,
  p_reply_to_message_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conversation public.admin_support_conversations%rowtype;
  v_existing_reply_id uuid;
  v_result jsonb;
begin
  if p_conversation_id is null or p_admin_id is null or p_message_id is null
    or p_reply_to_message_id is null or p_message_id = p_reply_to_message_id then
    raise exception 'Invalid support reply';
  end if;
  select * into v_conversation from public.admin_support_conversations
  where id = p_conversation_id for update;
  if not found then raise exception 'Reply target not found'; end if;
  v_result := public.admin_support_send_message_v1(v_conversation.reader_user_id, 'admin',
    p_admin_id, p_public_support_id, p_message_text, p_message_id, p_conversation_id);

  select reply_to_message_id into v_existing_reply_id from public.admin_support_messages
  where id = p_message_id and conversation_id = p_conversation_id for update;
  if (v_result->>'created')::boolean is false then
    if v_existing_reply_id is distinct from p_reply_to_message_id then
      raise exception 'Reply request ID already used';
    end if;
  else
    if not exists (select 1 from public.admin_support_messages
      where id = p_reply_to_message_id and conversation_id = p_conversation_id and deleted_at is null) then
      raise exception 'Reply target not found';
    end if;
    update public.admin_support_messages set reply_to_message_id = p_reply_to_message_id
    where id = p_message_id and conversation_id = p_conversation_id;
  end if;
  return jsonb_set(v_result, '{message,reply_to_message_id}', to_jsonb(p_reply_to_message_id), true);
end;
$$;

revoke all on function public.admin_support_admin_message_action_v1(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_support_admin_reply_v1(uuid, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_support_admin_message_action_v1(uuid, text, uuid, text, text) to service_role;
grant execute on function public.admin_support_admin_reply_v1(uuid, text, text, text, uuid, uuid) to service_role;

commit;
