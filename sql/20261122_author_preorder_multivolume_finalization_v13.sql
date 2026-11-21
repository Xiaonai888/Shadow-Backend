create or replace function public.author_preorder_finalize_multivolume_paid(
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
  v_order public.author_preorder_orders%rowtype;
  v_intent public.author_preorder_payment_intents%rowtype;
  v_line record;
  v_book public.author_preorder_books%rowtype;
  v_legacy bigint;
  v_held bigint;
  v_item_count integer;
  v_hold_count integer;
  v_updated integer;
  v_result jsonb;
begin
  select author_page_id into v_page_id from public.author_preorder_orders where id = p_order_id;
  if v_page_id is null then raise exception 'PRE_ORDER_MULTI_PAID_ORDER_NOT_FOUND'; end if;
  perform 1 from public.author_pages where id = v_page_id for update;
  if not found then raise exception 'PRE_ORDER_MULTI_PAID_AUTHOR_NOT_FOUND'; end if;
  select * into v_order from public.author_preorder_orders
    where id = p_order_id and author_page_id = v_page_id for update;
  if not found then raise exception 'PRE_ORDER_MULTI_PAID_ORDER_NOT_FOUND'; end if;
  select * into v_intent from public.author_preorder_payment_intents
    where order_id = p_order_id;
  if not found or v_intent.merchant_transaction_id is distinct from p_payment_reference
     or v_intent.currency <> 'USD' or v_intent.expected_amount_usd <> v_order.total_usd then
    raise exception 'PRE_ORDER_MULTI_PAID_INTENT_MISMATCH';
  end if;
  select count(*) into v_item_count from public.author_preorder_order_items
    where order_id = p_order_id;
  select count(*) into v_hold_count from public.author_preorder_volume_holds
    where order_id = p_order_id;
  if v_item_count not between 1 and 10 or v_hold_count <> v_item_count
     or exists (
       select 1 from public.author_preorder_stock_holds where order_id = p_order_id
     ) then
    raise exception 'PRE_ORDER_MULTI_PAID_HOLD_COUNT_MISMATCH';
  end if;
  if exists (
    select 1 from public.author_preorder_order_items i
    left join public.author_preorder_volume_holds h
      on h.order_id = i.order_id and h.book_id = i.book_id
    where i.order_id = p_order_id and (
      h.order_id is null or h.edition is distinct from i.edition
      or h.quantity is distinct from i.quantity
      or h.status is distinct from case when v_order.payment_status = 'paid'
        then 'consumed' else 'held' end
    )
  ) then
    raise exception 'PRE_ORDER_MULTI_PAID_HOLD_ITEM_MISMATCH';
  end if;

  if v_order.payment_status = 'paid' then
    v_result := public.author_preorder_finalize_paid(p_order_id,p_payment_reference,p_provider_paid_at);
    return v_result || jsonb_build_object('hold_status','consumed','item_count',v_item_count);
  end if;
  if v_order.payment_status <> 'pending' or v_order.fulfillment_status <> 'awaiting_payment'
     or v_order.paid_at is not null then
    raise exception 'PRE_ORDER_MULTI_PAID_NOT_PENDING';
  end if;

  for v_line in
    select book_id,edition,quantity from public.author_preorder_volume_holds
      where order_id = p_order_id order by book_id
  loop
    select * into v_book from public.author_preorder_books
      where id = v_line.book_id and campaign_id = v_order.campaign_id for update;
    if not found then raise exception 'PRE_ORDER_MULTI_PAID_BOOK_MISMATCH'; end if;
    select coalesce(sum(quantity),0) into v_legacy from public.author_preorder_stock_holds
      where book_id = v_line.book_id and edition = v_line.edition and status = 'held';
    select coalesce(sum(quantity),0) into v_held from public.author_preorder_volume_holds
      where book_id = v_line.book_id and edition = v_line.edition and status = 'held';
    if v_line.edition = 'standard' then
      if v_book.standard_reserved::bigint + v_legacy + v_held > v_book.standard_quota::bigint then
        raise exception 'PRE_ORDER_MULTI_PAID_QUOTA_MISMATCH';
      end if;
    elsif v_line.edition = 'limited' then
      if v_book.limited_reserved::bigint + v_legacy + v_held > v_book.limited_quota::bigint then
        raise exception 'PRE_ORDER_MULTI_PAID_QUOTA_MISMATCH';
      end if;
    else
      raise exception 'PRE_ORDER_MULTI_PAID_EDITION_INVALID';
    end if;
  end loop;
  v_result := public.author_preorder_finalize_paid(p_order_id,p_payment_reference,p_provider_paid_at);
  if (v_result->>'newly_paid')::boolean is distinct from true then
    raise exception 'PRE_ORDER_MULTI_PAID_FINALIZATION_MISMATCH';
  end if;
  update public.author_preorder_volume_holds
    set status = 'consumed',consumed_at = clock_timestamp()
    where order_id = p_order_id and status = 'held';
  get diagnostics v_updated = row_count;
  if v_updated <> v_item_count then raise exception 'PRE_ORDER_MULTI_PAID_CONSUMPTION_FAILED'; end if;
  return v_result || jsonb_build_object('hold_status','consumed','item_count',v_item_count);
end;
$$;

revoke all on function public.author_preorder_finalize_multivolume_paid(uuid,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.author_preorder_finalize_multivolume_paid(uuid,text,timestamptz)
  to service_role;

create or replace function public.author_preorder_release_uninitialized_multivolume_hold(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page_id uuid;
  v_order public.author_preorder_orders%rowtype;
  v_total integer;
  v_held integer;
  v_released integer;
  v_changed integer;
  v_expiry timestamptz;
begin
  select author_page_id into v_page_id from public.author_preorder_orders where id = p_order_id;
  if v_page_id is null then raise exception 'PRE_ORDER_MULTI_RELEASE_ORDER_NOT_FOUND'; end if;
  perform 1 from public.author_pages where id = v_page_id for update;
  if not found then raise exception 'PRE_ORDER_MULTI_RELEASE_AUTHOR_NOT_FOUND'; end if;
  select * into v_order from public.author_preorder_orders where id = p_order_id for update;
  select count(*),count(*) filter (where status='held'),
    count(*) filter (where status='released'),max(expires_at)
    into v_total,v_held,v_released,v_expiry
    from public.author_preorder_volume_holds where order_id = p_order_id;
  if v_total not between 1 and 10 then raise exception 'PRE_ORDER_MULTI_RELEASE_HOLD_MISSING'; end if;
  if v_released = v_total and v_order.payment_status = 'expired' then
    return jsonb_build_object('order_id',p_order_id,'released',true,'reused',true);
  end if;
  if v_held <> v_total or v_order.payment_status <> 'pending'
     or v_order.fulfillment_status <> 'awaiting_payment' or v_order.paid_at is not null
     or v_expiry > clock_timestamp() then
    raise exception 'PRE_ORDER_MULTI_RELEASE_NOT_READY';
  end if;
  if exists (select 1 from public.author_preorder_payment_intents where order_id = p_order_id)
     or exists (select 1 from public.author_preorder_fee_ledger where order_id = p_order_id)
     or v_order.payment_reference is not null then
    raise exception 'PRE_ORDER_MULTI_RELEASE_PROVIDER_REVIEW_REQUIRED';
  end if;
  update public.author_preorder_volume_holds
    set status='released',released_at=clock_timestamp()
    where order_id=p_order_id and status='held';
  get diagnostics v_changed = row_count;
  if v_changed <> v_total then raise exception 'PRE_ORDER_MULTI_RELEASE_CONFLICT'; end if;
  update public.author_preorder_orders
    set payment_status='expired',fulfillment_status='cancelled',updated_at=now()
    where id=p_order_id and payment_status='pending';
  if not found then raise exception 'PRE_ORDER_MULTI_RELEASE_CONFLICT'; end if;
  return jsonb_build_object('order_id',p_order_id,'released',true,'reused',false,'item_count',v_total);
end;
$$;

revoke all on function public.author_preorder_release_uninitialized_multivolume_hold(uuid)
  from public, anon, authenticated;
grant execute on function public.author_preorder_release_uninitialized_multivolume_hold(uuid)
  to service_role;
