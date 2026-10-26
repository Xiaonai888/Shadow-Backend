begin;

alter table public.admin_support_messages
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists reply_to_message_id uuid references public.admin_support_messages(id) on delete set null;

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
    end if;
    update public.admin_support_conversations
    set last_message_preview = case
      when last_message_at = v_message.created_at then left(v_text, 500)
      else last_message_preview
    end
    where id = v_conversation.id;
  else
    if v_message.deleted_at is null then
      update public.admin_support_messages
      set deleted_at = now()
      where id = p_message_id
      returning * into v_message;
      update public.admin_support_conversations
      set last_message_preview = case
        when last_message_at = v_message.created_at then 'Message deleted'
        else last_message_preview
      end
      where id = v_conversation.id;
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

create or replace function public.admin_support_reader_reply_v1(
  p_reader_user_id uuid,
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
  v_conversation_id uuid;
  v_existing_reply_id uuid;
  v_result jsonb;
begin
  if p_reader_user_id is null or p_message_id is null or p_reply_to_message_id is null
    or p_message_id = p_reply_to_message_id then
    raise exception 'Invalid support reply';
  end if;

  select id into v_conversation_id
  from public.admin_support_conversations
  where reader_user_id = p_reader_user_id
  for update;

  if v_conversation_id is null or not exists (
    select 1 from public.admin_support_messages
    where id = p_reply_to_message_id
      and conversation_id = v_conversation_id
      and deleted_at is null
  ) then
    raise exception 'Reply target not found';
  end if;

  v_result := public.admin_support_send_message_v1(
    p_reader_user_id, 'reader', null, null,
    p_message_text, p_message_id, v_conversation_id
  );

  select reply_to_message_id into v_existing_reply_id
  from public.admin_support_messages
  where id = p_message_id and conversation_id = v_conversation_id
  for update;

  if (v_result->>'created')::boolean is false and v_existing_reply_id is null then
    raise exception 'Reply request ID belongs to an earlier message';
  end if;

  if v_existing_reply_id is not null and v_existing_reply_id <> p_reply_to_message_id then
    raise exception 'Reply request ID is already used for another target';
  end if;

  update public.admin_support_messages
  set reply_to_message_id = p_reply_to_message_id
  where id = p_message_id and conversation_id = v_conversation_id
    and reply_to_message_id is distinct from p_reply_to_message_id;

  return jsonb_set(v_result, '{message,reply_to_message_id}', to_jsonb(p_reply_to_message_id), true);
end;
$$;

revoke all on function public.admin_support_reader_message_action_v1(uuid, uuid, text, text)
from public, anon, authenticated;
revoke all on function public.admin_support_reader_reply_v1(uuid, text, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.admin_support_reader_message_action_v1(uuid, uuid, text, text)
to service_role;
grant execute on function public.admin_support_reader_reply_v1(uuid, text, uuid, uuid)
to service_role;

commit;
