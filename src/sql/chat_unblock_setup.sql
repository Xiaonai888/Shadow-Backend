alter table public.chat_conversations
add column if not exists status_before_block text;

alter table public.chat_conversations
add column if not exists request_decided_at_before_block timestamptz;

update public.chat_conversations as conversation
set status_before_block =
  case
    when exists (
      select 1
      from public.chat_messages as message
      where message.conversation_id =
        conversation.id
        and message.is_request_message = false
        and message.deleted_at is null
    )
      then 'accepted'
    else 'pending'
  end
where conversation.request_status = 'blocked'
  and conversation.status_before_block is null;
