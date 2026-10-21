create or replace function public.get_chat_unread_sender_count_v1(
  p_user_id uuid,
  p_role text default 'reader'
)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  with eligible_conversations as (
    select
      p.conversation_id,
      p.last_read_at,
      p.cleared_at,
      c.cleared_for_all_at,
      c.created_by_user_id,
      c.request_status
    from public.chat_participants as p
    join public.chat_conversations as c
      on c.id = p.conversation_id
    where p.user_id = p_user_id
      and p.participant_role = p_role
      and p.deleted_at is null
      and p.archived_at is null
      and c.request_status is distinct from 'blocked'
      and c.request_status is distinct from 'declined'
  ),
  unread_senders as (
    select m.sender_user_id as sender_id
    from eligible_conversations as c
    join public.chat_messages as m
      on m.conversation_id = c.conversation_id
    where m.sender_user_id <> p_user_id
      and m.deleted_at is null
      and m.created_at > coalesce(
        greatest(
          c.last_read_at,
          c.cleared_at,
          c.cleared_for_all_at
        ),
        '-infinity'::timestamptz
      )
    union
    select c.created_by_user_id as sender_id
    from eligible_conversations as c
    where c.request_status = 'pending'
      and c.created_by_user_id is not null
      and c.created_by_user_id <> p_user_id
  )
  select count(distinct sender_id)::bigint
  from unread_senders;
$$;

revoke all on function public.get_chat_unread_sender_count_v1(uuid, text) from public, anon, authenticated;
grant execute on function public.get_chat_unread_sender_count_v1(uuid, text) to service_role;
