begin;

create table if not exists public.author_store_book_chat_links (
  order_id uuid primary key references public.author_store_orders(id) on delete restrict,
  hold_id uuid not null unique references public.author_store_book_payment_holds(id) on delete restrict,
  conversation_id uuid not null references public.chat_conversations(id) on delete restrict,
  reader_popup_seen_at timestamptz,
  author_popup_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists author_store_book_chat_links_conversation_idx
  on public.author_store_book_chat_links (conversation_id, created_at desc);

alter table public.author_store_book_chat_links enable row level security;
revoke all on public.author_store_book_chat_links from public, anon, authenticated;
grant select, insert, update on public.author_store_book_chat_links to service_role;

create or replace function public.link_author_store_paid_book_to_chat(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.author_store_orders%rowtype;
  v_hold public.author_store_book_payment_holds%rowtype;
  v_author_id uuid;
  v_conversation_id uuid;
  v_conversation_status text;
  v_direct_key text;
  v_link_order_id uuid;
  v_now timestamptz := now();
begin
  if p_order_id is null then
    raise exception 'Order ID is required' using errcode = '22023';
  end if;

  select * into v_order
  from public.author_store_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if v_order.payment_status is distinct from 'paid'
     or lower(coalesce(v_order.order_status, v_order.status, '')) in ('cancelled', 'canceled', 'refunded', 'rejected', 'expired')
     or v_order.buyer_id is null
     or not exists (
       select 1 from public.author_store_book_hold_activation a
       where a.id = 1 and v_order.created_at >= a.activated_at
     ) then
    return jsonb_build_object('ok', true, 'linked', false, 'reason', 'not_eligible');
  end if;

  select * into v_hold
  from public.author_store_book_payment_holds
  where order_id = v_order.id;

  if not found or v_hold.status = 'refunded'
     or v_hold.buyer_id is distinct from v_order.buyer_id
     or v_hold.author_page_id is distinct from v_order.author_page_id then
    return jsonb_build_object('ok', true, 'linked', false, 'reason', 'hold_unavailable');
  end if;

  if not exists (
    select 1 from public.author_store_order_items i
    where i.order_id = v_order.id and lower(btrim(coalesce(i.product_type, ''))) = 'book'
  ) then
    return jsonb_build_object('ok', true, 'linked', false, 'reason', 'not_physical_book');
  end if;

  select a.user_id into v_author_id
  from public.author_pages a
  where a.id = v_order.author_page_id;

  if v_author_id is null or v_author_id = v_order.buyer_id then
    return jsonb_build_object('ok', true, 'linked', false, 'reason', 'invalid_participants');
  end if;

  select l.order_id, l.conversation_id
  into v_link_order_id, v_conversation_id
  from public.author_store_book_chat_links l
  where l.order_id = v_order.id;

  if found then
    return jsonb_build_object('ok', true, 'linked', true, 'created', false,
      'conversation_id', v_conversation_id, 'order_id', v_order.id);
  end if;

  if exists (
    select 1 from public.chat_blocks b
    where (b.blocker_user_id = v_order.buyer_id and b.blocked_user_id = v_author_id)
       or (b.blocker_user_id = v_author_id and b.blocked_user_id = v_order.buyer_id)
  ) then
    return jsonb_build_object('ok', true, 'linked', false, 'reason', 'chat_blocked');
  end if;

  v_direct_key := 'reader_author:' || v_order.buyer_id::text || ':' || v_order.author_page_id::text;

  select c.id, c.request_status
  into v_conversation_id, v_conversation_status
  from public.chat_conversations c
  where c.direct_key = v_direct_key
  for update;

  if found and v_conversation_status in ('blocked', 'declined') then
    return jsonb_build_object('ok', true, 'linked', false, 'reason', 'chat_restricted');
  end if;

  if v_conversation_id is null then
    insert into public.chat_conversations (
      conversation_type, direct_key, created_by_user_id, author_page_id,
      request_status, request_decided_at
    ) values (
      'reader_author', v_direct_key, v_order.buyer_id, v_order.author_page_id,
      'accepted', v_now
    ) on conflict (direct_key) do nothing
    returning id into v_conversation_id;

    if v_conversation_id is null then
      select id, request_status
      into v_conversation_id, v_conversation_status
      from public.chat_conversations
      where direct_key = v_direct_key
      for update;
      if v_conversation_status in ('blocked', 'declined') then
        return jsonb_build_object('ok', true, 'linked', false, 'reason', 'chat_restricted');
      end if;
    end if;
  end if;

  if v_conversation_id is null then
    raise exception 'Chat conversation could not be created' using errcode = 'P0001';
  end if;

  insert into public.chat_participants (conversation_id, user_id, participant_role)
  values
    (v_conversation_id, v_order.buyer_id, 'reader'),
    (v_conversation_id, v_author_id, 'author')
  on conflict do nothing;

  insert into public.author_store_book_chat_links (
    order_id, hold_id, conversation_id
  ) values (v_order.id, v_hold.id, v_conversation_id)
  on conflict (order_id) do nothing;

  return jsonb_build_object('ok', true, 'linked', true, 'created', true,
    'conversation_id', v_conversation_id, 'order_id', v_order.id);
end;
$$;

revoke all on function public.link_author_store_paid_book_to_chat(uuid)
  from public, anon, authenticated;
grant execute on function public.link_author_store_paid_book_to_chat(uuid)
  to service_role;

commit;
