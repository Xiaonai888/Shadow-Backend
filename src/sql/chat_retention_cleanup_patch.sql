create or replace function public.purge_expired_chat_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_message_ids uuid[];
  v_conversation_ids uuid[];
  v_record_ids uuid[];
  v_deleted_messages integer := 0;
  v_deleted_conversations integer := 0;
  v_closed_records integer := 0;
begin
  select array_agg(distinct m.id)
  into v_message_ids
  from public.chat_messages m
  join public.chat_conversations c
    on c.id = m.conversation_id
  where m.deleted_at is not null
    and m.retention_until is not null
    and m.retention_until <= v_now
    and (
      c.legal_hold_at is null
      or c.legal_hold_released_at is not null
    )
    and not exists (
      select 1
      from public.chat_retention_records r
      where r.message_id = m.id
        and r.legal_hold_at is not null
        and r.legal_hold_released_at is null
        and r.purged_at is null
    );

  if coalesce(array_length(v_message_ids, 1), 0) > 0 then
    delete from public.chat_message_pins
    where message_id = any(v_message_ids);

    update public.chat_retention_records
    set
      purged_at = v_now,
      updated_at = v_now
    where message_id = any(v_message_ids)
      and purged_at is null;

    delete from public.chat_messages
    where id = any(v_message_ids);

    get diagnostics v_deleted_messages = row_count;
  end if;

  select array_agg(distinct c.id)
  into v_conversation_ids
  from public.chat_conversations c
  where c.cleared_for_all_at is not null
    and c.retention_until is not null
    and c.retention_until <= v_now
    and (
      c.legal_hold_at is null
      or c.legal_hold_released_at is not null
    )
    and not exists (
      select 1
      from public.chat_retention_records r
      where r.conversation_id = c.id
        and r.legal_hold_at is not null
        and r.legal_hold_released_at is null
        and r.purged_at is null
    )
    and not exists (
      select 1
      from public.chat_message_reports mr
      where mr.conversation_id = c.id
        and mr.status in ('pending', 'reviewing')
    );

  if coalesce(array_length(v_conversation_ids, 1), 0) > 0 then
    update public.chat_retention_records
    set
      purged_at = v_now,
      updated_at = v_now
    where conversation_id = any(v_conversation_ids)
      and purged_at is null;

    delete from public.chat_message_pins
    where conversation_id = any(v_conversation_ids);

    delete from public.chat_messages
    where conversation_id = any(v_conversation_ids);

    delete from public.chat_participants
    where conversation_id = any(v_conversation_ids);

    delete from public.chat_conversations
    where id = any(v_conversation_ids);

    get diagnostics v_deleted_conversations = row_count;
  end if;

  select array_agg(r.id)
  into v_record_ids
  from public.chat_retention_records r
  left join public.chat_conversations c
    on c.id = r.conversation_id
  where r.purged_at is null
    and r.retention_until <= v_now
    and (
      r.legal_hold_at is null
      or r.legal_hold_released_at is not null
    )
    and (
      c.id is null
      or c.legal_hold_at is null
      or c.legal_hold_released_at is not null
    )
    and not exists (
      select 1
      from public.chat_message_reports mr
      where mr.conversation_id = r.conversation_id
        and mr.status in ('pending', 'reviewing')
    );

  if coalesce(array_length(v_record_ids, 1), 0) > 0 then
    update public.chat_participants p
    set purged_at = v_now
    from public.chat_retention_records r
    where r.id = any(v_record_ids)
      and r.resource_type = 'conversation'
      and r.delete_scope = 'for_me'
      and r.affected_user_id = p.user_id
      and r.conversation_id = p.conversation_id
      and p.deleted_at = r.deleted_at;

    update public.chat_retention_records
    set
      purged_at = v_now,
      updated_at = v_now
    where id = any(v_record_ids)
      and purged_at is null;

    get diagnostics v_closed_records = row_count;
  end if;

  return jsonb_build_object(
    'purged_at', v_now,
    'deleted_messages', v_deleted_messages,
    'deleted_conversations', v_deleted_conversations,
    'closed_retention_records', v_closed_records
  );
end;
$$;

revoke all
on function public.purge_expired_chat_data()
from public, anon, authenticated;

grant execute
on function public.purge_expired_chat_data()
to service_role;
