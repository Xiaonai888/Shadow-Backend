create or replace function public.author_preorder_finalize_paid(
  p_order_id uuid,
  p_payment_reference text,
  p_provider_paid_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page_id uuid;
  v_locked_page uuid;
  v_order public.author_preorder_orders%rowtype;
  v_campaign public.author_preorder_campaigns%rowtype;
  v_book public.author_preorder_books%rowtype;
  v_line record;
  v_reference text;
  v_paid_at timestamptz;
  v_item_count bigint;
  v_subtotal numeric(12,2);
  v_number bigint;
  v_fee numeric(12,3);
  v_ledger public.author_preorder_fee_ledger%rowtype;
begin
  v_reference := btrim(coalesce(p_payment_reference, ''));
  if p_order_id is null or length(v_reference) < 3 or length(v_reference) > 160
     or v_reference ~ '[[:cntrl:]]' then
    raise exception 'PRE_ORDER_INVALID_PAYMENT_CONFIRMATION';
  end if;

  if p_provider_paid_at is not null and p_provider_paid_at > now() + interval '10 minutes' then
    raise exception 'PRE_ORDER_INVALID_PAID_AT';
  end if;

  select o.author_page_id into v_page_id
  from public.author_preorder_orders o
  where o.id = p_order_id;

  if v_page_id is null then
    raise exception 'PRE_ORDER_PAYMENT_ORDER_NOT_FOUND';
  end if;

  select p.id into v_locked_page
  from public.author_pages p
  where p.id = v_page_id
  for update;

  if v_locked_page is null then
    raise exception 'PRE_ORDER_PAYMENT_AUTHOR_NOT_FOUND';
  end if;

  select o.* into v_order
  from public.author_preorder_orders o
  where o.id = p_order_id and o.author_page_id = v_page_id
  for update;

  if not found then
    raise exception 'PRE_ORDER_PAYMENT_ORDER_NOT_FOUND';
  end if;

  if v_order.payment_status = 'paid' then
    if v_order.payment_reference is distinct from v_reference or v_order.paid_at is null then
      raise exception 'PRE_ORDER_PAYMENT_REPLAY_MISMATCH';
    end if;

    select l.* into v_ledger
    from public.author_preorder_fee_ledger l
    where l.order_id = v_order.id and l.author_page_id = v_page_id;

    if not found then
      raise exception 'PRE_ORDER_PAYMENT_LEDGER_MISSING';
    end if;

    return jsonb_build_object(
      'order_id', v_order.id,
      'campaign_id', v_order.campaign_id,
      'paid_at', v_order.paid_at,
      'successful_order_number', v_ledger.successful_order_number,
      'service_fee_usd', v_ledger.service_fee_usd,
      'newly_paid', false
    );
  end if;

  if v_order.payment_status <> 'pending'
     or v_order.fulfillment_status <> 'awaiting_payment'
     or v_order.paid_at is not null then
    raise exception 'PRE_ORDER_PAYMENT_NOT_PENDING';
  end if;

  if v_order.payment_reference is not null
     and v_order.payment_reference is distinct from v_reference then
    raise exception 'PRE_ORDER_PAYMENT_REFERENCE_MISMATCH';
  end if;

  if exists (
    select 1 from public.author_preorder_orders other
    where other.payment_reference = v_reference and other.id <> p_order_id
  ) then
    raise exception 'PRE_ORDER_PAYMENT_REFERENCE_IN_USE';
  end if;

  select c.* into v_campaign
  from public.author_preorder_campaigns c
  where c.id = v_order.campaign_id and c.author_page_id = v_page_id
  for update;

  if not found then
    raise exception 'PRE_ORDER_PAYMENT_RECORD_MISMATCH';
  end if;

  if jsonb_typeof(v_order.buyer_snapshot) <> 'object'
     or v_order.buyer_snapshot = '{}'::jsonb
     or jsonb_typeof(v_order.delivery_snapshot) <> 'object'
     or v_order.delivery_snapshot = '{}'::jsonb then
    raise exception 'PRE_ORDER_PAYMENT_SNAPSHOT_MISSING';
  end if;

  select count(*), coalesce(sum(i.quantity::numeric * i.unit_price_usd), 0)
    into v_item_count, v_subtotal
  from public.author_preorder_order_items i
  where i.order_id = v_order.id;

  if v_item_count = 0 or v_order.total_usd <= 0
     or v_order.subtotal_usd <> v_subtotal
     or v_order.total_usd <> v_subtotal + v_order.signature_fee_usd + v_order.delivery_fee_usd
     or (v_order.signature_requested = false and v_order.signature_fee_usd <> 0) then
    raise exception 'PRE_ORDER_PAYMENT_AMOUNT_MISMATCH';
  end if;

  for v_line in
    select i.book_id, i.edition, sum(i.quantity)::bigint as quantity
    from public.author_preorder_order_items i
    where i.order_id = v_order.id
    group by i.book_id, i.edition
    order by i.book_id, i.edition
  loop
    select b.* into v_book
    from public.author_preorder_books b
    where b.id = v_line.book_id and b.campaign_id = v_order.campaign_id
    for update;

    if not found then
      raise exception 'PRE_ORDER_PAYMENT_BOOK_MISMATCH';
    end if;

    if v_line.edition = 'standard' then
      if not v_book.standard_enabled
         or v_line.quantity > v_book.standard_quota - v_book.standard_reserved then
        raise exception 'PRE_ORDER_STANDARD_QUOTA_EXCEEDED';
      end if;

      update public.author_preorder_books
      set standard_reserved = standard_reserved + v_line.quantity
      where id = v_book.id;
    elsif v_line.edition = 'limited' then
      if not v_book.limited_enabled
         or v_line.quantity > v_book.limited_quota - v_book.limited_reserved then
        raise exception 'PRE_ORDER_LIMITED_QUOTA_EXCEEDED';
      end if;

      update public.author_preorder_books
      set limited_reserved = limited_reserved + v_line.quantity
      where id = v_book.id;
    else
      raise exception 'PRE_ORDER_PAYMENT_INVALID_EDITION';
    end if;
  end loop;

  select coalesce(max(l.successful_order_number), 0) + 1
    into v_number
  from public.author_preorder_fee_ledger l
  where l.author_page_id = v_page_id;

  v_fee := case when v_number <= 10000 then 0::numeric(12,3) else 0.125::numeric(12,3) end;
  v_paid_at := coalesce(p_provider_paid_at, now());

  update public.author_preorder_orders
  set payment_status = 'paid',
      fulfillment_status = 'reserved',
      payment_reference = v_reference,
      paid_at = v_paid_at,
      updated_at = now()
  where id = v_order.id;

  insert into public.author_preorder_fee_ledger (
    author_page_id, order_id, successful_order_number, service_fee_usd
  ) values (
    v_page_id, v_order.id, v_number, v_fee
  );

  update public.author_preorder_campaigns
  set total_orders = total_orders + 1,
      updated_at = now()
  where id = v_campaign.id;

  return jsonb_build_object(
    'order_id', v_order.id,
    'campaign_id', v_order.campaign_id,
    'paid_at', v_paid_at,
    'successful_order_number', v_number,
    'service_fee_usd', v_fee,
    'newly_paid', true
  );
end;
$$;

revoke all on function public.author_preorder_finalize_paid(uuid,text,timestamptz)
  from public, anon, authenticated;

grant execute on function public.author_preorder_finalize_paid(uuid,text,timestamptz)
  to service_role;
