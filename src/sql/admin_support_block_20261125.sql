begin;

alter table public.admin_support_conversations
  add column if not exists support_blocked_at timestamptz,
  add column if not exists support_blocked_by_admin_id text;

create or replace function public.admin_support_guard_reader_insert_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_blocked_at timestamptz;
begin
  if new.sender_kind = 'reader' then
    select support_blocked_at into v_blocked_at
    from public.admin_support_conversations
    where id = new.conversation_id for update;
    if not found then raise exception 'Support conversation not found'; end if;
    if v_blocked_at is not null then
      raise exception using message = 'SUPPORT_CHAT_BLOCKED', errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.admin_support_guard_reader_insert_v1() from public, anon, authenticated;
grant execute on function public.admin_support_guard_reader_insert_v1() to service_role;

drop trigger if exists admin_support_guard_reader_insert_v1 on public.admin_support_messages;
create trigger admin_support_guard_reader_insert_v1
before insert on public.admin_support_messages
for each row when (new.sender_kind = 'reader')
execute function public.admin_support_guard_reader_insert_v1();

create or replace function public.admin_support_set_block_v1(
  p_conversation_id uuid,
  p_admin_id text,
  p_blocked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_chat public.admin_support_conversations%rowtype;
  v_changed boolean;
begin
  if p_conversation_id is null or nullif(btrim(p_admin_id), '') is null or p_blocked is null then
    raise exception 'Invalid support block input';
  end if;
  if not exists (select 1 from public.admin_users
    where id::text = p_admin_id and lower(role) = 'owner'
      and lower(coalesce(status, 'active')) = 'active') then
    raise exception 'Support block owner required';
  end if;
  select * into v_chat from public.admin_support_conversations
  where id = p_conversation_id for update;
  if not found then raise exception 'Support conversation not found'; end if;
  v_changed := (v_chat.support_blocked_at is not null) is distinct from p_blocked;
  if v_changed then
    update public.admin_support_conversations
    set support_blocked_at = case when p_blocked then clock_timestamp() else null end,
      support_blocked_by_admin_id = case when p_blocked then p_admin_id else null end
    where id = p_conversation_id returning * into v_chat;
    insert into public.admin_support_activity (conversation_id, conversation_ref, admin_id, action, details)
    values (p_conversation_id, p_conversation_id, p_admin_id,
      case when p_blocked then 'support_block' else 'support_unblock' end,
      jsonb_build_object('blocked', p_blocked));
  end if;
  return jsonb_build_object('ok', true, 'conversation_id', v_chat.id,
    'blocked', v_chat.support_blocked_at is not null, 'changed', v_changed);
end;
$$;

revoke all on function public.admin_support_set_block_v1(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.admin_support_set_block_v1(uuid, text, boolean) to service_role;

commit;
