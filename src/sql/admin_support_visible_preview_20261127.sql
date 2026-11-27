begin;

create or replace function public.refresh_support_visible_preview_v1(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_latest_at timestamptz;
  v_latest_preview text;
begin
  perform 1 from public.admin_support_conversations
  where id = p_conversation_id for update;
  if not found then return; end if;

  select m.created_at,
    coalesce(left(nullif(btrim(m.message_text), ''), 500),
      case when jsonb_array_length(m.attachments) > 0 then 'Image' else null end)
  into v_latest_at, v_latest_preview
  from public.admin_support_messages m
  where m.conversation_id = p_conversation_id and m.deleted_at is null
  order by m.created_at desc, m.id desc limit 1;

  update public.admin_support_conversations
  set last_message_at = v_latest_at, last_message_preview = v_latest_preview
  where id = p_conversation_id
    and (last_message_at is distinct from v_latest_at
      or last_message_preview is distinct from v_latest_preview);
end;
$$;

create or replace function public.repair_support_deleted_previews_v1(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select c.id from public.admin_support_conversations c
    where c.last_message_preview = 'Message deleted'
      and not exists (
        select 1 from public.admin_support_messages m
        where m.conversation_id = c.id and m.deleted_at is null
          and m.created_at = c.last_message_at
          and left(nullif(btrim(m.message_text), ''), 500) = c.last_message_preview
      )
    order by c.id
    limit greatest(1, least(coalesce(p_limit, 100), 100))
    for update of c skip locked
  loop
    perform public.refresh_support_visible_preview_v1(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.admin_support_reader_message_action_v1(
  p_reader_user_id uuid,
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
  v_text text := btrim(coalesce(p_message_text, ''));
begin
  if p_reader_user_id is null or p_message_id is null or p_action is null
    or p_action not in ('edit', 'delete') then
    raise exception 'Invalid reader message action';
  end if;

  select * into v_conversation
  from public.admin_support_conversations
  where reader_user_id = p_reader_user_id
  for update;

  if not found then
    raise exception 'Support message not found';
  end if;

  if v_conversation.status = 'archived' then
    raise exception 'Archived support chat is read only';
  end if;

  select * into v_message
  from public.admin_support_messages
  where id = p_message_id
    and conversation_id = v_conversation.id
    and sender_kind = 'reader'
  for update;

  if not found then
    raise exception 'Support message not found';
  end if;

  if p_action = 'edit' then
    if v_message.deleted_at is not null then
      raise exception 'Deleted support message cannot be edited';
    end if;
    if char_length(v_text) < 1 or char_length(v_text) > 2000 then
      raise exception 'Message must contain 1–2000 characters';
    end if;
    if v_message.message_text is distinct from v_text then
      update public.admin_support_messages
      set message_text = v_text, edited_at = now()
      where id = p_message_id
      returning * into v_message;
      perform public.refresh_support_visible_preview_v1(v_conversation.id);
    end if;
  else
    if v_message.deleted_at is null then
      update public.admin_support_messages
      set deleted_at = now()
      where id = p_message_id
      returning * into v_message;
      perform public.refresh_support_visible_preview_v1(v_conversation.id);
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'message', jsonb_build_object(
      'id', v_message.id,
      'message_text', case when v_message.deleted_at is null then v_message.message_text else null end,
      'edited_at', v_message.edited_at,
      'deleted_at', v_message.deleted_at,
      'reply_to_message_id', v_message.reply_to_message_id
    )
  );
end;
$$;

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
    perform public.refresh_support_visible_preview_v1(p_conversation_id);
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

revoke all on function public.refresh_support_visible_preview_v1(uuid) from public, anon, authenticated;
revoke all on function public.repair_support_deleted_previews_v1(integer) from public, anon, authenticated;
revoke all on function public.admin_support_reader_message_action_v1(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_support_admin_message_action_v1(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.repair_support_deleted_previews_v1(integer) to service_role;
grant execute on function public.admin_support_reader_message_action_v1(uuid, uuid, text, text) to service_role;
grant execute on function public.admin_support_admin_message_action_v1(uuid, text, uuid, text, text) to service_role;

commit;
