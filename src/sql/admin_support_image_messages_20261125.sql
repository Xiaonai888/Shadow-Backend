begin;

create or replace function public.admin_support_send_image_v1(
  p_actor_kind text, p_actor_id text, p_conversation_id uuid,
  p_public_support_id text, p_message_id uuid, p_message_text text, p_attachment jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_chat public.admin_support_conversations%rowtype;
  v_message public.admin_support_messages%rowtype;
  v_role text;
  v_caption text := nullif(btrim(p_message_text), '');
  v_mime text := p_attachment->>'mime_type';
  v_key text := p_attachment->>'storage_key';
  v_size integer;
  v_created boolean := false;
  v_now timestamptz;
begin
  if p_actor_kind is null or p_actor_kind not in ('reader', 'admin') or nullif(btrim(p_actor_id), '') is null
    or p_message_id is null or char_length(coalesce(v_caption, '')) > 2000
    or jsonb_typeof(p_attachment) is distinct from 'object'
    or p_attachment->>'type' is distinct from 'image'
    or v_mime is null or v_mime not in ('image/webp', 'image/jpeg', 'image/png')
    or v_key is null or v_key !~ '^support-chat-media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(webp|jpg|png)$'
    or split_part(v_key, '.', 2) is distinct from (case v_mime when 'image/webp' then 'webp' when 'image/jpeg' then 'jpg' else 'png' end)
    or jsonb_typeof(p_attachment->'file_size') is distinct from 'number'
    or coalesce(p_attachment->>'file_size', '') !~ '^[0-9]{1,7}$' then
    raise exception 'Invalid support image input';
  end if;
  v_size := (p_attachment->>'file_size')::integer;
  if v_size not between 32 and 2097152 then raise exception 'Invalid support image size'; end if;

  if p_actor_kind = 'reader' then
    if p_conversation_id is not null or p_public_support_id is not null then raise exception 'Invalid support image input'; end if;
    if not exists (select 1 from public.users where id = p_actor_id::uuid and is_active = true) then raise exception 'Reader account is unavailable'; end if;
    insert into public.admin_support_conversations (reader_user_id) values (p_actor_id::uuid) on conflict (reader_user_id) do nothing;
    select * into v_chat from public.admin_support_conversations where reader_user_id = p_actor_id::uuid for update;
  else
    if p_conversation_id is null or coalesce(p_public_support_id, '') !~ '^S-[0-9A-F]{8}$' then raise exception 'Invalid support image input'; end if;
    select * into v_chat from public.admin_support_conversations where id = p_conversation_id for update;
    select lower(role) into v_role from public.admin_users where id::text = p_actor_id and lower(coalesce(status, 'active')) = 'active';
    if v_role is null or v_role not in ('owner', 'admin', 'staff') or (v_role = 'staff' and v_chat.assigned_admin_id is distinct from p_actor_id) then raise exception 'Support conversation not found'; end if;
  end if;
  if v_chat.id is null then raise exception 'Support conversation not found'; end if;
  if not exists (select 1 from public.users where id = v_chat.reader_user_id and is_active = true) then raise exception 'Reader account is unavailable'; end if;

  select * into v_message from public.admin_support_messages where id = p_message_id;
  if found then
    if v_message.conversation_id <> v_chat.id or v_message.sender_kind <> p_actor_kind
      or (p_actor_kind = 'admin' and v_message.sender_admin_id is distinct from p_actor_id)
      or (v_message.edited_at is null and v_message.message_text is distinct from v_caption)
      or jsonb_array_length(v_message.attachments) <> 1
      or v_message.attachments->0->>'type' is distinct from 'image'
      or v_message.attachments->0->>'mime_type' is distinct from v_mime
      or v_message.attachments->0->>'file_size' is distinct from v_size::text then
      raise exception 'Support image request conflict';
    end if;
  else
    if v_chat.status = 'archived' then raise exception 'Archived support chat is read only'; end if;
    if p_actor_kind = 'reader' and v_chat.support_blocked_at is not null then raise exception 'SUPPORT_CHAT_BLOCKED'; end if;
    v_now := clock_timestamp();
    insert into public.admin_support_messages (id, conversation_id, sender_kind, sender_admin_id, public_support_id, message_text, attachments, created_at)
    values (p_message_id, v_chat.id, p_actor_kind, case when p_actor_kind = 'admin' then p_actor_id else null end,
      p_public_support_id, v_caption, jsonb_build_array(jsonb_build_object('type', 'image', 'storage_key', v_key, 'mime_type', v_mime, 'file_size', v_size)), v_now)
    returning * into v_message;
    v_created := true;
    update public.admin_support_conversations set
      last_message_at = greatest(coalesce(last_message_at, v_now), v_now),
      last_message_preview = case when last_message_at is null or last_message_at <= v_now then coalesce(left(v_caption, 500), 'Image') else last_message_preview end,
      unread_for_admin = unread_for_admin + case when p_actor_kind = 'reader' then 1 else 0 end,
      unread_for_reader = unread_for_reader + case when p_actor_kind = 'admin' then 1 else 0 end
    where id = v_chat.id;
    if p_actor_kind = 'admin' then
      insert into public.admin_support_activity (conversation_id, conversation_ref, admin_id, action, details)
      values (v_chat.id, v_chat.id, p_actor_id, 'reply', jsonb_build_object('message_id', p_message_id, 'type', 'image'));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'created', v_created, 'conversation_id', v_chat.id,
    'message', jsonb_build_object('id', v_message.id, 'conversation_id', v_message.conversation_id,
      'sender_kind', v_message.sender_kind, 'public_support_id', v_message.public_support_id,
      'message_text', case when v_message.deleted_at is null then v_message.message_text else null end,
      'attachments', case when v_message.deleted_at is null then v_message.attachments else '[]'::jsonb end,
      'created_at', v_message.created_at, 'edited_at', v_message.edited_at, 'deleted_at', v_message.deleted_at,
      'seen_at', v_message.seen_at, 'reply_to_message_id', v_message.reply_to_message_id));
end;
$$;

revoke all on function public.admin_support_send_image_v1(text, text, uuid, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.admin_support_send_image_v1(text, text, uuid, text, uuid, text, jsonb) to service_role;

commit;
