begin;

create or replace function public.submit_author_store_book_delivery_evidence(
  p_hold_id uuid,
  p_author_user_id uuid,
  p_delivery_company text,
  p_tracking_number text,
  p_proof_url text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.author_store_orders%rowtype;
  v_hold public.author_store_book_payment_holds%rowtype;
  v_company text := btrim(coalesce(p_delivery_company, ''));
  v_tracking text := btrim(coalesce(p_tracking_number, ''));
  v_url text := btrim(coalesce(p_proof_url, ''));
  v_refs jsonb;
  v_now timestamptz := now();
begin
  if p_hold_id is null or p_author_user_id is null then
    raise exception 'Hold and author are required' using errcode = '22023';
  end if;

  if char_length(v_company) < 2 or char_length(v_company) > 120
     or (v_tracking <> '' and (char_length(v_tracking) < 4 or char_length(v_tracking) > 120))
     or char_length(v_url) < 12 or char_length(v_url) > 1024
     or v_url !~* '^https://[^[:space:]<>"'']+$' then
    raise exception 'Delivery company and valid HTTPS shipping proof are required; tracking number is optional' using errcode = '22023';
  end if;

  select o.* into v_order
    from public.author_store_orders o
    join public.author_store_book_payment_holds h on h.order_id = o.id
    where h.id = p_hold_id
    for update of o;

  if not found then
    raise exception 'Book payment hold not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.author_pages a
    where a.id = v_order.author_page_id and a.user_id = p_author_user_id
  ) then
    raise exception 'Only this author may submit delivery evidence' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.author_store_book_hold_activation a
    where a.id = 1 and v_order.created_at >= a.activated_at
  ) then
    raise exception 'Legacy orders are not part of the book payment hold system' using errcode = '23514';
  end if;

  select * into v_hold
    from public.author_store_book_payment_holds
    where id = p_hold_id
    for update;

  if not found or v_hold.author_page_id is distinct from v_order.author_page_id
     or v_hold.status not in ('awaiting_reader', 'under_review')
     or lower(coalesce(v_order.payment_status, '')) <> 'paid'
     or lower(coalesce(v_order.order_status, v_order.status, '')) not in ('shipped', 'completed')
     or v_hold.held_amount_cents <= 0 then
    raise exception 'Verified paid and shipped physical book with active hold required' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.author_store_order_items i
    where i.order_id = v_order.id and lower(btrim(coalesce(i.product_type, ''))) = 'book'
  ) then
    raise exception 'Physical book items are required' using errcode = '23514';
  end if;

  v_refs := jsonb_build_array(jsonb_build_object(
    'url', v_url,
    'submitted_at', v_now,
    'tracking_number', v_tracking,
    'delivery_company', v_company
  ));

  update public.author_store_book_payment_holds
     set status = 'under_review',
         delivery_company = v_company,
         tracking_number = v_tracking,
         proof_refs = v_refs,
         review_requested_at = coalesce(review_requested_at, v_now),
         updated_at = v_now
   where id = p_hold_id
     and status in ('awaiting_reader', 'under_review');

  if not found then
    raise exception 'Book payment hold changed; retry shipping confirmation' using errcode = '40001';
  end if;

  insert into public.author_store_book_payment_hold_events (
    hold_id, action, actor_type, actor_id, reason, evidence_refs
  ) values (
    p_hold_id, 'shipment_updated', 'author', p_author_user_id::text,
    'Author submitted verified shipment information; reader confirmation is still required', v_refs
  );

  if v_hold.status = 'awaiting_reader' then
    insert into public.author_store_book_payment_hold_events (
      hold_id, action, actor_type, actor_id, reason, evidence_refs
    ) values (
      p_hold_id, 'review_requested', 'author', p_author_user_id::text,
      'Owner review is available if the reader cannot confirm receipt', v_refs
    );
  end if;

  return jsonb_build_object('ok', true, 'hold_id', p_hold_id, 'status', 'under_review');
end;
$$;

revoke all on function public.submit_author_store_book_delivery_evidence(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_author_store_book_delivery_evidence(uuid, uuid, text, text, text)
  to service_role;

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

  select * into v_order
    from public.author_store_orders
    where id = p_order_id
    for update;

  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if v_order.buyer_id is distinct from p_buyer_id then
    raise exception 'Only this buyer may confirm receipt' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.author_store_book_hold_activation a
    where a.id = 1 and v_order.created_at >= a.activated_at
  ) then
    raise exception 'Legacy orders are not part of the book payment hold system' using errcode = '23514';
  end if;

  select * into v_hold
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
      'ok', true, 'already_confirmed', true,
      'order_id', v_order.id, 'hold_id', v_hold.id,
      'status', 'released', 'released_at', v_hold.released_at
    );
  end if;

  if v_hold.status not in ('awaiting_reader', 'under_review') then
    raise exception 'This book payment cannot be confirmed in its current state' using errcode = '23514';
  end if;

  if lower(coalesce(v_order.payment_status, '')) <> 'paid' then
    raise exception 'Order payment is not verified' using errcode = '23514';
  end if;

  if lower(coalesce(v_order.order_status, v_order.status, '')) not in ('shipped', 'completed') then
    raise exception 'Book must be shipped before receipt confirmation' using errcode = '23514';
  end if;

  if v_hold.held_amount_cents <= 0
     or char_length(btrim(coalesce(v_hold.delivery_company, ''))) < 2
     or coalesce(jsonb_array_length(v_hold.proof_refs), 0) = 0 then
    raise exception 'Delivery company and shipment proof are required before releasing payment' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.author_store_order_items i
    where i.order_id = v_order.id and lower(btrim(coalesce(i.product_type, ''))) = 'book'
  ) then
    raise exception 'Physical book items are required' using errcode = '23514';
  end if;

  update public.author_store_book_payment_holds
     set status = 'released',
         reader_confirmed_at = v_confirmed_at,
         released_at = v_confirmed_at,
         release_source = 'reader',
         updated_at = v_confirmed_at
   where id = v_hold.id
     and status in ('awaiting_reader', 'under_review');

  if not found then
    raise exception 'Book payment status changed; retry confirmation' using errcode = '40001';
  end if;

  insert into public.author_store_book_payment_hold_events (
    hold_id, action, actor_type, actor_id, reason
  ) values
    (v_hold.id, 'reader_confirmed', 'reader', p_buyer_id::text, 'Reader confirmed receipt after shipment proof'),
    (v_hold.id, 'released', 'reader', p_buyer_id::text, 'Book payment released after reader receipt confirmation');

  return jsonb_build_object(
    'ok', true, 'already_confirmed', false,
    'order_id', v_order.id, 'hold_id', v_hold.id,
    'status', 'released', 'released_at', v_confirmed_at
  );
end;
$$;

revoke all on function public.confirm_author_store_book_received(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.confirm_author_store_book_received(uuid, uuid)
  to service_role;

commit;
