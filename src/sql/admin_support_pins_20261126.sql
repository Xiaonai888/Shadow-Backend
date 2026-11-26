begin;

create table if not exists public.admin_support_message_pins (
  conversation_id uuid not null references public.admin_support_conversations(id) on delete cascade,
  message_id uuid not null references public.admin_support_messages(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (conversation_id, message_id)
);

alter table public.admin_support_message_pins enable row level security;
revoke all on table public.admin_support_message_pins from public, anon, authenticated, service_role;

create or replace function public.admin_support_pins_v1(
  p_actor_kind text, p_actor_id text, p_conversation_id uuid,
  p_action text, p_message_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_chat public.admin_support_conversations%rowtype;
  v_role text;
  v_pins jsonb;
  v_changed integer := 0;
begin
  if p_actor_kind is null or p_actor_kind not in ('reader', 'admin')
    or nullif(btrim(p_actor_id), '') is null
    or p_action is null or p_action not in ('list', 'pin', 'unpin')
    or (p_action <> 'list' and p_message_id is null)
    or (p_actor_kind = 'admin' and p_conversation_id is null) then
    raise exception 'SUPPORT_PIN_INVALID';
  end if;
  if p_actor_kind = 'admin' then
    select lower(role) into v_role from public.admin_users
    where id::text = p_actor_id and lower(coalesce(status, 'active')) = 'active';
    if v_role is null or v_role not in ('owner', 'admin', 'staff') then
      raise exception 'SUPPORT_PIN_NOT_FOUND';
    end if;
  end if;
  if p_actor_kind = 'reader' then
    if p_action = 'list' then
      select * into v_chat from public.admin_support_conversations where reader_user_id = p_actor_id::uuid;
    else
      select * into v_chat from public.admin_support_conversations where reader_user_id = p_actor_id::uuid for update;
    end if;
  else
    if p_action = 'list' then
      select * into v_chat from public.admin_support_conversations where id = p_conversation_id;
    else
      select * into v_chat from public.admin_support_conversations where id = p_conversation_id for update;
    end if;
  end if;
  if v_chat.id is null then
    if p_actor_kind = 'reader' and p_action = 'list' then
      return jsonb_build_object('ok', true, 'pins', '[]'::jsonb, 'limit', 50);
    end if;
    raise exception 'SUPPORT_PIN_NOT_FOUND';
  end if;
  if p_actor_kind = 'admin' and v_role = 'staff' and v_chat.assigned_admin_id is distinct from p_actor_id then
    raise exception 'SUPPORT_PIN_NOT_FOUND';
  end if;
  if p_action <> 'list' then
    if v_chat.status = 'archived' then raise exception 'SUPPORT_PIN_ARCHIVED'; end if;
    if p_actor_kind = 'reader' and v_chat.support_blocked_at is not null then
      raise exception 'SUPPORT_CHAT_BLOCKED';
    end if;
    if not exists (select 1 from public.admin_support_messages
      where id = p_message_id and conversation_id = v_chat.id
      and (p_action = 'unpin' or deleted_at is null)) then
      raise exception 'SUPPORT_PIN_NOT_FOUND';
    end if;
    if p_action = 'pin' then
      delete from public.admin_support_message_pins p
      using public.admin_support_messages m
      where p.conversation_id = v_chat.id and m.id = p.message_id and m.deleted_at is not null;
      if not exists (select 1 from public.admin_support_message_pins
        where conversation_id = v_chat.id and message_id = p_message_id) then
        if (select count(*) from public.admin_support_message_pins where conversation_id = v_chat.id) >= 50 then
          raise exception 'SUPPORT_PIN_LIMIT';
        end if;
        insert into public.admin_support_message_pins (conversation_id, message_id)
        values (v_chat.id, p_message_id) on conflict do nothing;
        get diagnostics v_changed = row_count;
      end if;
    else
      delete from public.admin_support_message_pins
      where conversation_id = v_chat.id and message_id = p_message_id;
      get diagnostics v_changed = row_count;
    end if;
  end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.pinned_at desc, p.message_id desc), '[]'::jsonb)
  into v_pins from (
    select m.id as message_id, m.sender_kind, left(m.message_text, 500) as message_text,
      m.created_at, p.created_at as pinned_at,
      jsonb_array_length(coalesce(m.attachments, '[]'::jsonb)) > 0 as has_attachment
    from public.admin_support_message_pins p
    join public.admin_support_messages m on m.id = p.message_id and m.conversation_id = p.conversation_id
    where p.conversation_id = v_chat.id and m.deleted_at is null
    order by p.created_at desc, p.message_id desc limit 50
  ) p;
  return jsonb_build_object('ok', true, 'conversation_id', v_chat.id, 'pins', v_pins,
    'limit', 50, 'changed', v_changed > 0);
end;
$$;

revoke all on function public.admin_support_pins_v1(text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_support_pins_v1(text, text, uuid, text, uuid) to service_role;

commit;
