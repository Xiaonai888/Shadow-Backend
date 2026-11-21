create table if not exists public.author_preorder_checkout_requests (
  buyer_user_id uuid not null,
  request_key uuid not null,
  order_id uuid not null unique references public.author_preorder_orders(id) on delete restrict,
  request_sha256 text not null,
  created_at timestamptz not null default now(),
  primary key (buyer_user_id, request_key),
  constraint author_preorder_checkout_hash_chk check (request_sha256 ~ '^[0-9a-f]{64}$')
);

alter table public.author_preorder_checkout_requests enable row level security;
revoke all on public.author_preorder_checkout_requests from public, anon, authenticated;
grant select, insert on public.author_preorder_checkout_requests to service_role;

create or replace function public.author_preorder_create_pending_checkout(
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
  v_author_page_id uuid;
  v_author_status text;
  v_campaign public.author_preorder_campaigns%rowtype;
  v_book public.author_preorder_books%rowtype;
  v_existing public.author_preorder_checkout_requests%rowtype;
  v_order public.author_preorder_orders%rowtype;
  v_book_id uuid;
  v_edition text;
  v_quantity integer;
  v_delivery_key text;
  v_delivery_name text;
  v_delivery_logo text := '';
  v_delivery_fee numeric(12,2);
  v_delivery_active boolean;
  v_unit_price numeric(10,2);
  v_available integer;
  v_subtotal numeric(12,2);
  v_signature_fee numeric(12,2);
  v_total numeric(12,2);
  v_signature_requested boolean;
  v_signature_name text;
  v_buyer_note text;
  v_buyer jsonb;
  v_request_hash text;
  v_order_id uuid;
begin
  if p_buyer_user_id is null or p_campaign_id is null or p_request_key is null
     or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'PRE_ORDER_CHECKOUT_INVALID_REQUEST';
  end if;

  if jsonb_typeof(p_payload->'buyer_snapshot') <> 'object'
     or jsonb_typeof(p_payload->'quantity') <> 'number'
     or jsonb_typeof(p_payload->'signature_requested') <> 'boolean' then
    raise exception 'PRE_ORDER_CHECKOUT_INVALID_PAYLOAD';
  end if;

  v_buyer := p_payload->'buyer_snapshot';
  if length(btrim(coalesce(v_buyer->>'name', ''))) < 2
     or length(btrim(coalesce(v_buyer->>'phone_number', ''))) < 7
     or length(btrim(coalesce(v_buyer->>'delivery_address', ''))) < 6
     or length(coalesce(v_buyer->>'name','')) > 160
     or length(coalesce(v_buyer->>'phone_number','')) > 28
     or length(coalesce(v_buyer->>'delivery_address','')) > 800 then
    raise exception 'PRE_ORDER_CHECKOUT_BUYER_INVALID';
  end if;

  begin
    v_book_id := (p_payload->>'book_id')::uuid;
    v_quantity := (p_payload->>'quantity')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'PRE_ORDER_CHECKOUT_INVALID_PAYLOAD';
  end;

  v_edition := p_payload->>'edition';
  v_delivery_key := p_payload->>'delivery_company_key';
  v_signature_requested := (p_payload->>'signature_requested')::boolean;
  v_signature_name := btrim(coalesce(p_payload->>'signature_name', ''));
  v_buyer_note := btrim(coalesce(p_payload->>'buyer_note', ''));

  if v_book_id is null or v_quantity is null or v_quantity not between 1 and 99
     or v_edition is null or v_edition not in ('standard', 'limited')
     or v_delivery_key is null or v_delivery_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or length(v_signature_name) > 160 or length(v_buyer_note) > 1000
     or (v_signature_requested and v_signature_name = '') then
    raise exception 'PRE_ORDER_CHECKOUT_INVALID_SELECTION';
  end if;

  v_request_hash := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_user_id::text || ':' || p_request_key::text, 0));

  select * into v_existing
  from public.author_preorder_checkout_requests
  where buyer_user_id = p_buyer_user_id and request_key = p_request_key;

  if found then
    if v_existing.request_sha256 is distinct from v_request_hash then
      raise exception 'PRE_ORDER_CHECKOUT_IDEMPOTENCY_CONFLICT';
    end if;
    select * into v_order from public.author_preorder_orders
    where id = v_existing.order_id and buyer_user_id = p_buyer_user_id
      and campaign_id = p_campaign_id;
    if not found then
      raise exception 'PRE_ORDER_CHECKOUT_IDEMPOTENCY_ORDER_MISMATCH';
    end if;
    return jsonb_build_object(
      'order_id', v_order.id,
      'payment_status', v_order.payment_status,
      'total_usd', v_order.total_usd,
      'reused', true
    );
  end if;

  select author_page_id into v_author_page_id
  from public.author_preorder_campaigns where id = p_campaign_id;
  if v_author_page_id is null then
    raise exception 'PRE_ORDER_CHECKOUT_NOT_FOUND';
  end if;

  select status into v_author_status from public.author_pages
  where id = v_author_page_id for update;
  if v_author_status is distinct from 'active' then
    raise exception 'PRE_ORDER_CHECKOUT_AUTHOR_INACTIVE';
  end if;

  select * into v_campaign from public.author_preorder_campaigns
  where id = p_campaign_id and author_page_id = v_author_page_id for update;
  if not found or v_campaign.status <> 'active'
     or v_campaign.published_at is null or v_campaign.open_at is null
     or v_campaign.close_at is null or now() < v_campaign.open_at
     or now() >= v_campaign.close_at then
    raise exception 'PRE_ORDER_CHECKOUT_NOT_OPEN';
  end if;

  select * into v_book from public.author_preorder_books
  where id = v_book_id and campaign_id = p_campaign_id for update;
  if not found or (select count(*) from public.author_preorder_books where campaign_id = p_campaign_id) <> 1 then
    raise exception 'PRE_ORDER_CHECKOUT_BOOK_MISMATCH';
  end if;

  if v_edition = 'standard' then
    if not v_book.standard_enabled then raise exception 'PRE_ORDER_CHECKOUT_EDITION_DISABLED'; end if;
    v_unit_price := v_book.standard_price_usd;
    v_available := v_book.standard_quota - v_book.standard_reserved;
  else
    if not v_book.limited_enabled then raise exception 'PRE_ORDER_CHECKOUT_EDITION_DISABLED'; end if;
    v_unit_price := v_book.limited_price_usd;
    v_available := v_book.limited_quota - v_book.limited_reserved;
  end if;

  if v_available < v_quantity or v_unit_price <= 0 then
    raise exception 'PRE_ORDER_CHECKOUT_UNAVAILABLE';
  end if;

  if jsonb_typeof(v_campaign.delivery_company_keys) <> 'array'
     or not (v_campaign.delivery_company_keys ? v_delivery_key) then
    raise exception 'PRE_ORDER_CHECKOUT_DELIVERY_NOT_ALLOWED';
  end if;

  if v_delivery_key in ('jnt', 'vet') then
    select coalesce(s.fee_usd, 2::numeric), coalesce(s.is_active, true)
      into v_delivery_fee, v_delivery_active
    from (select 1) dummy left join public.author_store_delivery_settings s
      on s.author_page_id = v_author_page_id and s.company_key = v_delivery_key;
    if not v_delivery_active then
      raise exception 'PRE_ORDER_CHECKOUT_DELIVERY_INACTIVE';
    end if;
    v_delivery_name := case when v_delivery_key = 'jnt' then 'J&T Express' else 'VET Express' end;
  elsif v_delivery_key = 'custom' then
    select company_name, fee_usd, logo_url
      into v_delivery_name, v_delivery_fee, v_delivery_logo
    from public.author_store_custom_delivery_companies
    where author_page_id = v_author_page_id and is_active = true;
    if not found then raise exception 'PRE_ORDER_CHECKOUT_DELIVERY_INACTIVE'; end if;
  else
    raise exception 'PRE_ORDER_CHECKOUT_DELIVERY_INVALID';
  end if;

  if v_delivery_fee is null or v_delivery_fee < 0 or v_delivery_fee > 9999.99 then
    raise exception 'PRE_ORDER_CHECKOUT_DELIVERY_FEE_INVALID';
  end if;

  if v_signature_requested and not v_campaign.signature_enabled then
    raise exception 'PRE_ORDER_CHECKOUT_SIGNATURE_UNAVAILABLE';
  end if;
  v_signature_fee := case when v_signature_requested then v_campaign.signature_fee_usd else 0 end;
  v_subtotal := v_unit_price * v_quantity;
  v_total := v_subtotal + v_signature_fee + v_delivery_fee;
  if v_total <= 0 then raise exception 'PRE_ORDER_CHECKOUT_AMOUNT_INVALID'; end if;

  insert into public.author_preorder_orders (
    author_page_id, campaign_id, buyer_user_id,
    payment_status, fulfillment_status, subtotal_usd, signature_fee_usd,
    delivery_fee_usd, total_usd, buyer_snapshot, delivery_snapshot,
    signature_requested, signature_name, buyer_note
  ) values (
    v_author_page_id, p_campaign_id, p_buyer_user_id,
    'pending', 'awaiting_payment', v_subtotal, v_signature_fee,
    v_delivery_fee, v_total, v_buyer,
    jsonb_build_object(
      'address', v_buyer->>'delivery_address',
      'province_city', coalesce(v_buyer->>'province_city',''),
      'company', jsonb_build_object(
        'company_key', v_delivery_key,
        'company_name', v_delivery_name,
        'fee_usd', v_delivery_fee,
        'logo_url', coalesce(v_delivery_logo,'')
      )
    ),
    v_signature_requested, v_signature_name, v_buyer_note
  ) returning id into v_order_id;

  insert into public.author_preorder_order_items (
    order_id, book_id, edition, quantity, unit_price_usd, book_title_snapshot
  ) values (v_order_id, v_book_id, v_edition, v_quantity, v_unit_price, v_book.title);

  insert into public.author_preorder_checkout_requests (
    buyer_user_id, request_key, order_id, request_sha256
  ) values (p_buyer_user_id, p_request_key, v_order_id, v_request_hash);

  return jsonb_build_object(
    'order_id', v_order_id,
    'payment_status', 'pending',
    'total_usd', v_total,
    'reused', false
  );
end;
$$;

revoke all on function public.author_preorder_create_pending_checkout(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.author_preorder_create_pending_checkout(uuid,uuid,uuid,jsonb)
  to service_role;
