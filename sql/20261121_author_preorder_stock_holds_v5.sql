create table if not exists public.author_preorder_stock_holds (
  order_id uuid primary key references public.author_preorder_orders(id) on delete restrict,
  book_id uuid not null references public.author_preorder_books(id) on delete restrict,
  edition text not null,
  quantity integer not null,
  status text not null default 'held',
  held_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  released_at timestamptz,
  constraint author_preorder_hold_edition_chk check (edition in ('standard','limited')),
  constraint author_preorder_hold_quantity_chk check (quantity between 1 and 99),
  constraint author_preorder_hold_status_chk check (status in ('held','consumed','released')),
  constraint author_preorder_hold_expiry_chk check (expires_at > held_at),
  constraint author_preorder_hold_state_chk check (
    (status = 'held' and consumed_at is null and released_at is null)
    or (status = 'consumed' and consumed_at is not null and released_at is null)
    or (status = 'released' and consumed_at is null and released_at is not null)
  )
);

create index if not exists author_preorder_stock_holds_active_idx
  on public.author_preorder_stock_holds (book_id, edition)
  where status = 'held';

create index if not exists author_preorder_stock_holds_expiry_idx
  on public.author_preorder_stock_holds (expires_at, order_id)
  where status = 'held';

alter table public.author_preorder_stock_holds enable row level security;
revoke all on public.author_preorder_stock_holds from public, anon, authenticated;
grant select, insert, update on public.author_preorder_stock_holds to service_role;

create or replace function public.author_preorder_create_held_checkout(
  p_buyer_user_id uuid,
  p_campaign_id uuid,
  p_request_key uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_order public.author_preorder_orders%rowtype;
  v_item public.author_preorder_order_items%rowtype;
  v_book public.author_preorder_books%rowtype;
  v_hold public.author_preorder_stock_holds%rowtype;
  v_order_id uuid;
  v_item_count integer;
  v_held bigint;
  v_remaining bigint;
  v_expires_at timestamptz;
begin
  v_result := public.author_preorder_create_pending_checkout(
    p_buyer_user_id, p_campaign_id, p_request_key, p_payload
  );
  v_order_id := (v_result->>'order_id')::uuid;

  select * into v_order
  from public.author_preorder_orders
  where id = v_order_id and buyer_user_id = p_buyer_user_id
    and campaign_id = p_campaign_id
  for update;

  if not found or v_order.payment_status <> 'pending'
     or v_order.fulfillment_status <> 'awaiting_payment' or v_order.paid_at is not null then
    raise exception 'PRE_ORDER_HOLD_ORDER_NOT_PENDING';
  end if;

  select * into v_hold
  from public.author_preorder_stock_holds
  where order_id = v_order_id
  for update;

  if found then
    if v_hold.status <> 'held' or v_hold.expires_at <= clock_timestamp() then
      raise exception 'PRE_ORDER_HOLD_NOT_REUSABLE';
    end if;
    return v_result || jsonb_build_object(
      'hold_status', 'held', 'hold_expires_at', v_hold.expires_at,
      'inventory_held', true
    );
  end if;

  select count(*) into v_item_count
  from public.author_preorder_order_items where order_id = v_order_id;
  if v_item_count <> 1 then
    raise exception 'PRE_ORDER_HOLD_INVALID_ITEMS';
  end if;

  select * into v_item
  from public.author_preorder_order_items where order_id = v_order_id;

  select * into v_book
  from public.author_preorder_books
  where id = v_item.book_id and campaign_id = v_order.campaign_id
  for update;
  if not found or v_item.quantity not between 1 and 99 then
    raise exception 'PRE_ORDER_HOLD_BOOK_INVALID';
  end if;

  select coalesce(sum(quantity), 0) into v_held
  from public.author_preorder_stock_holds
  where book_id = v_item.book_id and edition = v_item.edition and status = 'held';

  if v_item.edition = 'standard' then
    if v_book.standard_enabled is not true then
      raise exception 'PRE_ORDER_HOLD_EDITION_UNAVAILABLE';
    end if;
    v_remaining := v_book.standard_quota::bigint - v_book.standard_reserved::bigint - v_held;
  elsif v_item.edition = 'limited' then
    if v_book.limited_enabled is not true then
      raise exception 'PRE_ORDER_HOLD_EDITION_UNAVAILABLE';
    end if;
    v_remaining := v_book.limited_quota::bigint - v_book.limited_reserved::bigint - v_held;
  else
    raise exception 'PRE_ORDER_HOLD_EDITION_INVALID';
  end if;

  if v_remaining < v_item.quantity then
    raise exception 'PRE_ORDER_HOLD_STOCK_UNAVAILABLE';
  end if;

  v_expires_at := clock_timestamp() + interval '15 minutes';
  insert into public.author_preorder_stock_holds (
    order_id, book_id, edition, quantity, held_at, expires_at
  ) values (
    v_order_id, v_item.book_id, v_item.edition,
    v_item.quantity, clock_timestamp(), v_expires_at
  );

  return v_result || jsonb_build_object(
    'hold_status', 'held', 'hold_expires_at', v_expires_at,
    'inventory_held', true
  );
end;
$$;

revoke all on function public.author_preorder_create_held_checkout(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.author_preorder_create_held_checkout(uuid,uuid,uuid,jsonb)
  to service_role;

create or replace function public.author_preorder_finalize_held_paid(
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
  v_locked_page_id uuid;
  v_order public.author_preorder_orders%rowtype;
  v_hold public.author_preorder_stock_holds%rowtype;
  v_book public.author_preorder_books%rowtype;
  v_intent public.author_preorder_payment_intents%rowtype;
  v_held bigint;
  v_result jsonb;
begin
  select author_page_id into v_page_id
  from public.author_preorder_orders where id = p_order_id;
  if v_page_id is null then
    raise exception 'PRE_ORDER_HOLD_ORDER_NOT_FOUND';
  end if;

  select id into v_locked_page_id from public.author_pages
  where id = v_page_id for update;
  if not found then
    raise exception 'PRE_ORDER_HOLD_AUTHOR_NOT_FOUND';
  end if;

  select * into v_order from public.author_preorder_orders
  where id = p_order_id and author_page_id = v_page_id for update;
  if not found then
    raise exception 'PRE_ORDER_HOLD_ORDER_NOT_FOUND';
  end if;

  select * into v_hold from public.author_preorder_stock_holds
  where order_id = p_order_id for update;
  if not found or v_hold.status not in ('held','consumed') then
    raise exception 'PRE_ORDER_HOLD_NOT_ACTIVE';
  end if;

  select * into v_intent from public.author_preorder_payment_intents
  where order_id = p_order_id;
  if not found or v_intent.merchant_transaction_id is distinct from p_payment_reference
     or v_intent.expected_amount_usd <> v_order.total_usd or v_intent.currency <> 'USD' then
    raise exception 'PRE_ORDER_HOLD_INTENT_MISMATCH';
  end if;

  if v_hold.status = 'consumed' then
    if v_order.payment_status <> 'paid' then
      raise exception 'PRE_ORDER_HOLD_PAID_STATE_MISMATCH';
    end if;
    return public.author_preorder_finalize_paid(
      p_order_id, p_payment_reference, p_provider_paid_at
    );
  end if;

  if v_order.payment_status <> 'pending' or v_order.paid_at is not null then
    raise exception 'PRE_ORDER_HOLD_ORDER_NOT_PENDING';
  end if;
  if (select count(*) from public.author_preorder_order_items where order_id = p_order_id) <> 1
     or not exists (
       select 1 from public.author_preorder_order_items i
       where i.order_id = p_order_id and i.book_id = v_hold.book_id
         and i.edition = v_hold.edition and i.quantity = v_hold.quantity
     ) then
    raise exception 'PRE_ORDER_HOLD_ITEM_MISMATCH';
  end if;

  select * into v_book from public.author_preorder_books
  where id = v_hold.book_id and campaign_id = v_order.campaign_id
  for update;
  if not found then
    raise exception 'PRE_ORDER_HOLD_BOOK_MISSING';
  end if;

  select coalesce(sum(quantity), 0) into v_held
  from public.author_preorder_stock_holds
  where book_id = v_hold.book_id and edition = v_hold.edition and status = 'held';

  if v_hold.edition = 'standard' then
    if v_book.standard_reserved::bigint + v_held > v_book.standard_quota::bigint then
      raise exception 'PRE_ORDER_HOLD_QUOTA_MISMATCH';
    end if;
  elsif v_hold.edition = 'limited' then
    if v_book.limited_reserved::bigint + v_held > v_book.limited_quota::bigint then
      raise exception 'PRE_ORDER_HOLD_QUOTA_MISMATCH';
    end if;
  else
    raise exception 'PRE_ORDER_HOLD_EDITION_INVALID';
  end if;

  v_result := public.author_preorder_finalize_paid(
    p_order_id, p_payment_reference, p_provider_paid_at
  );
  if (v_result->>'newly_paid')::boolean is distinct from true then
    raise exception 'PRE_ORDER_HOLD_FINALIZATION_MISMATCH';
  end if;

  update public.author_preorder_stock_holds
  set status = 'consumed', consumed_at = clock_timestamp()
  where order_id = p_order_id and status = 'held';
  if not found then
    raise exception 'PRE_ORDER_HOLD_CONSUMPTION_FAILED';
  end if;

  return v_result || jsonb_build_object('hold_status', 'consumed');
end;
$$;

revoke all on function public.author_preorder_finalize_held_paid(uuid,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.author_preorder_finalize_held_paid(uuid,text,timestamptz)
  to service_role;

create or replace function public.author_preorder_release_uninitialized_expired_hold(
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page_id uuid;
  v_locked_page_id uuid;
  v_order public.author_preorder_orders%rowtype;
  v_hold public.author_preorder_stock_holds%rowtype;
begin
  select author_page_id into v_page_id
  from public.author_preorder_orders where id = p_order_id;
  if v_page_id is null then
    raise exception 'PRE_ORDER_HOLD_ORDER_NOT_FOUND';
  end if;

  select id into v_locked_page_id from public.author_pages
  where id = v_page_id for update;
  if not found then
    raise exception 'PRE_ORDER_HOLD_AUTHOR_NOT_FOUND';
  end if;

  select * into v_order from public.author_preorder_orders
  where id = p_order_id for update;
  select * into v_hold from public.author_preorder_stock_holds
  where order_id = p_order_id for update;
  if not found then
    raise exception 'PRE_ORDER_HOLD_NOT_FOUND';
  end if;

  if v_hold.status = 'released' then
    return jsonb_build_object('order_id', p_order_id, 'released', true, 'reused', true);
  end if;
  if v_hold.status <> 'held' or v_order.payment_status <> 'pending'
     or v_order.fulfillment_status <> 'awaiting_payment' or v_order.paid_at is not null then
    raise exception 'PRE_ORDER_HOLD_NOT_RELEASABLE';
  end if;
  if v_hold.expires_at > clock_timestamp() then
    raise exception 'PRE_ORDER_HOLD_NOT_EXPIRED';
  end if;
  if exists (
    select 1 from public.author_preorder_payment_intents where order_id = p_order_id
  ) then
    raise exception 'PRE_ORDER_HOLD_PROVIDER_REVIEW_REQUIRED';
  end if;

  update public.author_preorder_stock_holds
  set status = 'released', released_at = clock_timestamp()
  where order_id = p_order_id and status = 'held';

  update public.author_preorder_orders
  set payment_status = 'expired', fulfillment_status = 'cancelled', updated_at = now()
  where id = p_order_id and payment_status = 'pending';

  return jsonb_build_object('order_id', p_order_id, 'released', true, 'reused', false);
end;
$$;

revoke all on function public.author_preorder_release_uninitialized_expired_hold(uuid)
  from public, anon, authenticated;
grant execute on function public.author_preorder_release_uninitialized_expired_hold(uuid)
  to service_role;

create or replace function public.author_preorder_stock_snapshot(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'book_id', b.id,
    'title', b.title,
    'standard', jsonb_build_object(
      'enabled', b.standard_enabled,
      'quota', b.standard_quota,
      'paid_reserved', b.standard_reserved,
      'payment_pending_held', h.standard_held,
      'available', case when b.standard_enabled then greatest(
        0::bigint, b.standard_quota::bigint - b.standard_reserved::bigint - h.standard_held
      ) else 0::bigint end
    ),
    'limited', jsonb_build_object(
      'enabled', b.limited_enabled,
      'quota', b.limited_quota,
      'paid_reserved', b.limited_reserved,
      'payment_pending_held', h.limited_held,
      'available', case when b.limited_enabled then greatest(
        0::bigint, b.limited_quota::bigint - b.limited_reserved::bigint - h.limited_held
      ) else 0::bigint end
    )
  ) order by b.position), '[]'::jsonb)
  from public.author_preorder_books b
  cross join lateral (
    select
      coalesce(sum(quantity) filter (where edition = 'standard'), 0)::bigint as standard_held,
      coalesce(sum(quantity) filter (where edition = 'limited'), 0)::bigint as limited_held
    from public.author_preorder_stock_holds h
    where h.book_id = b.id and h.status = 'held'
  ) h
  where b.campaign_id = p_campaign_id;
$$;

revoke all on function public.author_preorder_stock_snapshot(uuid)
  from public, anon, authenticated;
grant execute on function public.author_preorder_stock_snapshot(uuid)
  to service_role;
