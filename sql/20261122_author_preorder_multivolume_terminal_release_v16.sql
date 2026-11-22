create or replace function public.author_preorder_release_verified_multivolume_terminal_hold(
  p_order_id uuid,
  p_transaction_id text,
  p_staff_user_id uuid,
  p_provider_terminal_status text,
  p_evidence_reference text,
  p_verified_at timestamptz
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
  v_review public.author_preorder_terminal_reviews%rowtype;
  v_item_count integer;
  v_hold_count integer;
  v_held_count integer;
  v_released_count integer;
  v_updated integer;
  v_max_expiry timestamptz;
  v_min_expiry timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_order_id is null or p_staff_user_id is null
     or p_transaction_id is null or p_transaction_id !~ '^P[A-Z0-9]{12,39}$'
     or p_provider_terminal_status is null
     or p_provider_terminal_status not in ('EXPIRED','CANCELLED')
     or p_evidence_reference is null
     or p_evidence_reference !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,119}$'
     or p_verified_at is null
     or p_verified_at < v_now - interval '5 minutes'
     or p_verified_at > v_now + interval '30 seconds' then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_EVIDENCE_INVALID';
  end if;

  select author_page_id into v_page_id
  from public.author_preorder_orders where id = p_order_id;
  if v_page_id is null then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_ORDER_NOT_FOUND';
  end if;

  perform 1 from public.author_pages where id = v_page_id for update;
  if not found then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_AUTHOR_NOT_FOUND';
  end if;

  select * into v_order from public.author_preorder_orders
  where id = p_order_id and author_page_id = v_page_id for update;
  if not found then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_ORDER_NOT_FOUND';
  end if;

  select * into v_intent from public.author_preorder_payment_intents
  where order_id = p_order_id for update;
  if not found or v_intent.merchant_transaction_id is distinct from p_transaction_id
     or v_intent.currency <> 'USD'
     or v_intent.expected_amount_usd <> v_order.total_usd then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_INTENT_MISMATCH';
  end if;

  select * into v_review from public.author_preorder_terminal_reviews
  where order_id = p_order_id for update;
  if not found or v_review.merchant_transaction_id is distinct from p_transaction_id then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_REVIEW_MISSING';
  end if;

  perform 1 from public.author_preorder_volume_holds h
  where h.order_id = p_order_id order by h.book_id for update;

  select count(*) into v_item_count
  from public.author_preorder_order_items
  where order_id = p_order_id;

  select count(*),
         count(*) filter (where status = 'held' and consumed_at is null and released_at is null),
         count(*) filter (where status = 'released' and consumed_at is null and released_at is not null),
         max(expires_at), min(expires_at)
    into v_hold_count, v_held_count, v_released_count, v_max_expiry, v_min_expiry
  from public.author_preorder_volume_holds where order_id = p_order_id;

  if v_item_count not between 1 and 10 or v_hold_count <> v_item_count
     or exists (
       select 1 from public.author_preorder_stock_holds
       where order_id = p_order_id
     ) or exists (
       select 1 from public.author_preorder_order_items i
       left join public.author_preorder_volume_holds h
         on h.order_id = i.order_id and h.book_id = i.book_id
       where i.order_id = p_order_id and (
         h.book_id is null or h.edition is distinct from i.edition
         or h.quantity is distinct from i.quantity
       )
     ) or exists (
       select 1 from public.author_preorder_volume_holds h
       left join public.author_preorder_order_items i
         on i.order_id = h.order_id and i.book_id = h.book_id
       where h.order_id = p_order_id and i.book_id is null
     ) then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_HOLD_ITEM_MISMATCH';
  end if;

  if v_order.payment_status = 'expired' then
    if v_released_count = v_hold_count
       and v_order.fulfillment_status = 'cancelled'
       and v_order.paid_at is null
       and v_review.released_at is not null
       and v_review.released_by = p_staff_user_id
       and v_review.terminal_status = p_provider_terminal_status
       and v_review.evidence_reference = p_evidence_reference
       and v_intent.finalized_at is null
       and not exists (
         select 1 from public.author_preorder_fee_ledger
         where order_id = p_order_id
       ) then
      return jsonb_build_object(
        'order_id', p_order_id, 'released', true,
        'reused', true, 'item_count', v_item_count
      );
    end if;
    raise exception 'PRE_ORDER_MULTI_TERMINAL_REPLAY_MISMATCH';
  end if;

  if v_order.payment_status <> 'pending'
     or v_order.fulfillment_status <> 'awaiting_payment'
     or v_order.paid_at is not null or v_order.payment_reference is not null
     or v_intent.finalized_at is not null or v_review.released_at is not null
     or v_held_count <> v_hold_count
     or exists (
       select 1 from public.author_preorder_fee_ledger
       where order_id = p_order_id
     ) then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_RELEASE_NOT_ALLOWED';
  end if;

  if v_review.review_count < 2
     or v_review.first_checked_at > v_now - interval '2 minutes'
     or v_review.last_checked_at < v_now - interval '5 minutes'
     or v_review.last_checked_at > v_now + interval '30 seconds'
     or v_intent.expires_at is null
     or v_max_expiry is null or v_min_expiry is null
     or v_max_expiry - v_min_expiry > interval '2 minutes'
     or v_max_expiry > v_now - interval '30 minutes'
     or v_intent.expires_at > v_now - interval '30 minutes'
     or p_verified_at < greatest(v_max_expiry, v_intent.expires_at) then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_RELEASE_PREMATURE';
  end if;

  update public.author_preorder_volume_holds
  set status = 'released', released_at = v_now
  where order_id = p_order_id and status = 'held';
  get diagnostics v_updated = row_count;
  if v_updated <> v_item_count then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_RELEASE_CONFLICT';
  end if;

  update public.author_preorder_orders
  set payment_status = 'expired', fulfillment_status = 'cancelled', updated_at = now()
  where id = p_order_id and payment_status = 'pending';
  if not found then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_RELEASE_CONFLICT';
  end if;

  update public.author_preorder_terminal_reviews
  set released_at = v_now,
      released_by = p_staff_user_id,
      terminal_status = p_provider_terminal_status,
      evidence_reference = p_evidence_reference,
      verified_at = p_verified_at
  where order_id = p_order_id and released_at is null;
  if not found then
    raise exception 'PRE_ORDER_MULTI_TERMINAL_RELEASE_CONFLICT';
  end if;

  return jsonb_build_object(
    'order_id', p_order_id, 'released', true,
    'reused', false, 'item_count', v_item_count
  );
end;
$$;

revoke all on function public.author_preorder_release_verified_multivolume_terminal_hold(
  uuid,text,uuid,text,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.author_preorder_release_verified_multivolume_terminal_hold(
  uuid,text,uuid,text,text,timestamptz
) to service_role;
