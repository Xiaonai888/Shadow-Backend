begin;

create or replace function public.admin_support_mark_seen_v1(
  p_actor_kind text,
  p_actor_id text,
  p_conversation_id uuid,
  p_through_message_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_chat public.admin_support_conversations%rowtype;
  v_target public.admin_support_messages%rowtype;
  v_role text;
  v_sender text;
  v_seen_at timestamptz;
  v_changed integer;
  v_old integer;
  v_remaining integer;
  v_unread integer;
begin
  if p_actor_kind is null or p_actor_kind not in ('admin', 'reader')
    or nullif(btrim(p_actor_id), '') is null or p_through_message_id is null
    or (p_actor_kind = 'admin' and p_conversation_id is null) then
    raise exception 'Invalid support seen input';
  end if;

  if p_actor_kind = 'reader' then
    select * into v_chat from public.admin_support_conversations
    where reader_user_id = p_actor_id::uuid for update;
    v_sender := 'admin';
  else
    select * into v_chat from public.admin_support_conversations
    where id = p_conversation_id for update;
    v_sender := 'reader';
  end if;
  if v_chat.id is null then raise exception 'Support conversation not found'; end if;

  if p_actor_kind = 'admin' then
    select lower(role) into v_role from public.admin_users
    where id::text = p_actor_id and lower(coalesce(status, 'active')) = 'active';
    if v_role is null or v_role not in ('owner', 'admin', 'staff')
      or (v_role = 'staff' and v_chat.assigned_admin_id is distinct from p_actor_id) then
      raise exception 'Support conversation not found';
    end if;
    v_old := v_chat.unread_for_admin;
  else
    v_old := v_chat.unread_for_reader;
  end if;

  select * into v_target from public.admin_support_messages
  where id = p_through_message_id and conversation_id = v_chat.id and sender_kind = v_sender;
  if not found then raise exception 'Support seen target not found'; end if;

  v_seen_at := clock_timestamp();
  update public.admin_support_messages
  set seen_at = v_seen_at
  where conversation_id = v_chat.id and sender_kind = v_sender
    and seen_at is null
    and (created_at, id) <= (v_target.created_at, v_target.id);
  get diagnostics v_changed = row_count;

  select count(*)::integer into v_remaining from public.admin_support_messages
  where conversation_id = v_chat.id and sender_kind = v_sender
    and seen_at is null;
  v_unread := least(v_old, v_remaining);

  if v_old is distinct from v_unread then
    if p_actor_kind = 'admin' then
      update public.admin_support_conversations set unread_for_admin = v_unread where id = v_chat.id;
      insert into public.admin_support_activity (conversation_id, conversation_ref, admin_id, action, details)
      values (v_chat.id, v_chat.id, p_actor_id, 'read',
        jsonb_build_object('from', v_old::text, 'to', v_unread::text));
    else
      update public.admin_support_conversations set unread_for_reader = v_unread where id = v_chat.id;
    end if;
  end if;

  select seen_at into v_seen_at from public.admin_support_messages where id = p_through_message_id;
  return jsonb_build_object('ok', true, 'conversation_id', v_chat.id,
    'through_message_id', p_through_message_id, 'seen_at', v_seen_at,
    'changed_count', v_changed, 'unread_count', v_unread,
    'unread_changed', v_old is distinct from v_unread,
    'assigned_admin_id', v_chat.assigned_admin_id);
end;
$$;

revoke all on function public.admin_support_mark_seen_v1(text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_support_mark_seen_v1(text, text, uuid, uuid) to service_role;

commit;
