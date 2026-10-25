begin;

create or replace function public.confirm_author_store_book_received(
  p_order_id uuid,
  p_buyer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.author_store_orders%rowtype;
  v_hold public.author_store_book_payment_holds%rowtype;
  v_confirmed_at timestamptz := now();
begin
  if p_order_id is null or p_buyer_id is null then
    raise exception 'Order and buyer are required' using errcode = '22023';
  end if;

  select *
    into v_order
    from public.author_store_orders
    where id = p_order_id
    for update;

  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if v_order.buyer_id is distinct from p_buyer_id then
    raise exception 'Not authorized to confirm this order' using errcode = '42501';
  end if;

  select *
    into v_hold
    from public.author_store_book_payment_holds
    where order_id = v_order.id
    for update;

  if not found then
    raise exception 'Physical book payment hold not found' using errcode = 'P0002';
  end if;

  if v_hold.buyer_id is distinct from p_buyer_id
     or v_hold.author_page_id is distinct from v_order.author_page_id then
    raise exception 'Book payment hold ownership mismatch' using errcode = '42501';
  end if;

  if v_hold.status = 'released' and v_hold.release_source = 'reader' then
    return jsonb_build_object(
      'ok', true,
      'already_confirmed', true,
      'order_id', v_order.id,
      'hold_id', v_hold.id,
      'status', 'released',
      'released_at', v_hold.released_at
    );
  end if;

  if v_hold.status <> 'awaiting_reader' then
    raise exception 'This book payment cannot be confirmed in its current state'
      using errcode = '23514';
  end if;

  if lower(coalesce(v_order.payment_status, '')) <> 'paid' then
    raise exception 'Order payment is not verified'
      using errcode = '23514';
  end if;

  if lower(coalesce(v_order.order_status, v_order.status, ''))
     not in ('shipped', 'completed') then
    raise exception 'Book must be shipped before receipt confirmation'
      using errcode = '23514';
  end if;

  if v_hold.held_amount_cents <= 0 then
    raise exception 'Invalid physical book payment hold'
      using errcode = '23514';
  end if;

  update public.author_store_book_payment_holds
     set status = 'released',
         reader_confirmed_at = v_confirmed_at,
         released_at = v_confirmed_at,
         release_source = 'reader',
         updated_at = v_confirmed_at
   where id = v_hold.id
     and status = 'awaiting_reader';

  if not found then
    raise exception 'Book payment status changed; retry confirmation'
      using errcode = '40001';
  end if;

  insert into public.author_store_book_payment_hold_events (
    hold_id, action, actor_type, actor_id, reason
  )
  values
    (v_hold.id, 'reader_confirmed', 'reader', p_buyer_id::text, 'Reader confirmed physical book receipt'),
    (v_hold.id, 'released', 'reader', p_buyer_id::text, 'Book payment released after reader confirmation');

  return jsonb_build_object(
    'ok', true,
    'already_confirmed', false,
    'order_id', v_order.id,
    'hold_id', v_hold.id,
    'status', 'released',
    'released_at', v_confirmed_at
  );
end;
$$;

revoke all on function public.confirm_author_store_book_received(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.confirm_author_store_book_received(uuid, uuid)
  to service_role;

commit;
