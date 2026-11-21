create or replace function public.author_preorder_create_multivolume_held_checkout(
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
  v_line jsonb;
  v_book_id uuid;
  v_book_ids uuid[] := array[]::uuid[];
  v_edition text;
  v_quantity integer;
  v_delivery_key text;
  v_delivery_name text;
  v_delivery_logo text := '';
  v_delivery_fee numeric(12,2);
  v_delivery_active boolean;
  v_unit_price numeric(10,2);
  v_remaining bigint;
  v_legacy bigint;
  v_held bigint;
  v_subtotal numeric(12,2) := 0;
  v_signature_fee numeric(12,2);
  v_total numeric(12,2);
  v_signed boolean;
  v_signature_name text;
  v_buyer_note text;
  v_buyer jsonb;
  v_hash text;
  v_order_id uuid;
  v_expiry timestamptz;
  v_item_count integer;
  v_hold_count integer;
  v_locked_count integer;
begin
  if p_buyer_user_id is null or p_campaign_id is null or p_request_key is null
     or jsonb_typeof(p_payload) is distinct from 'object'
     or jsonb_typeof(p_payload->'items') is distinct from 'array'
     or jsonb_array_length(p_payload->'items') not between 1 and 10
     or jsonb_typeof(p_payload->'buyer_snapshot') is distinct from 'object'
     or jsonb_typeof(p_payload->'signature_requested') is distinct from 'boolean' then
    raise exception 'PRE_ORDER_MULTI_CHECKOUT_INVALID';
  end if;

  v_buyer := p_payload->'buyer_snapshot';
  if length(btrim(coalesce(v_buyer->>'name',''))) not between 2 and 160
     or length(btrim(coalesce(v_buyer->>'phone_number',''))) not between 7 and 28
     or length(btrim(coalesce(v_buyer->>'delivery_address',''))) not between 6 and 800
     or length(coalesce(v_buyer->>'province_city','')) > 120
     or length(coalesce(v_buyer->>'telegram_username','')) > 250
     or length(coalesce(v_buyer->>'facebook_link','')) > 500 then
    raise exception 'PRE_ORDER_MULTI_BUYER_INVALID';
  end if;

  v_delivery_key := p_payload->>'delivery_company_key';
  v_signed := (p_payload->>'signature_requested')::boolean;
  v_signature_name := btrim(coalesce(p_payload->>'signature_name',''));
  v_buyer_note := btrim(coalesce(p_payload->>'buyer_note',''));
  if v_delivery_key is null or v_delivery_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or length(v_signature_name) > 160 or length(v_buyer_note) > 1000
     or (v_signed and v_signature_name = '') then
    raise exception 'PRE_ORDER_MULTI_SELECTION_INVALID';
  end if;

  for v_line in select value from jsonb_array_elements(p_payload->'items') loop
    if jsonb_typeof(v_line) is distinct from 'object'
       or jsonb_typeof(v_line->'quantity') is distinct from 'number'
       or jsonb_typeof(v_line->'book_id') is distinct from 'string'
       or jsonb_typeof(v_line->'edition') is distinct from 'string' then
      raise exception 'PRE_ORDER_MULTI_ITEM_INVALID';
    end if;
    begin
      v_book_id := (v_line->>'book_id')::uuid;
      v_quantity := (v_line->>'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'PRE_ORDER_MULTI_ITEM_INVALID';
    end;
    if v_book_id is null or v_book_id = any(v_book_ids)
       or v_quantity not between 1 and 99
       or (v_line->>'edition') not in ('standard','limited') then
      raise exception 'PRE_ORDER_MULTI_ITEM_INVALID';
    end if;
    v_book_ids := array_append(v_book_ids, v_book_id);
  end loop;

  v_hash := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_user_id::text || ':' || p_request_key::text, 0));
  select * into v_existing from public.author_preorder_checkout_requests
    where buyer_user_id = p_buyer_user_id and request_key = p_request_key;
  if found then
    if v_existing.request_sha256 is distinct from v_hash then
      raise exception 'PRE_ORDER_MULTI_IDEMPOTENCY_CONFLICT';
    end if;
    select * into v_order from public.author_preorder_orders
      where id = v_existing.order_id and buyer_user_id = p_buyer_user_id
        and campaign_id = p_campaign_id;
    if not found then raise exception 'PRE_ORDER_MULTI_REPLAY_ORDER_MISMATCH'; end if;
    select count(*) into v_item_count from public.author_preorder_order_items
      where order_id = v_order.id;
    select count(*) into v_hold_count from public.author_preorder_volume_holds
      where order_id = v_order.id and status = 'held'
        and expires_at > clock_timestamp();
    if v_item_count <> array_length(v_book_ids, 1) or v_hold_count <> v_item_count
       or v_order.payment_status <> 'pending' or v_order.paid_at is not null
       or exists (
         select 1 from public.author_preorder_order_items i
         left join public.author_preorder_volume_holds h
           on h.order_id = i.order_id and h.book_id = i.book_id
         where i.order_id = v_order.id and
           (h.order_id is null or h.status <> 'held' or h.quantity <> i.quantity
            or h.edition <> i.edition or h.expires_at <= clock_timestamp())
       ) then
      raise exception 'PRE_ORDER_MULTI_REPLAY_NOT_PAYABLE';
    end if;
    select min(expires_at) into v_expiry from public.author_preorder_volume_holds
      where order_id = v_order.id;
    return jsonb_build_object('order_id',v_order.id,'payment_status','pending',
      'total_usd',v_order.total_usd,'reused',true,'inventory_held',true,
      'hold_status','held','hold_expires_at',v_expiry,'item_count',v_item_count);
  end if;

  select author_page_id into v_author_page_id from public.author_preorder_campaigns
    where id = p_campaign_id;
  if v_author_page_id is null then raise exception 'PRE_ORDER_MULTI_NOT_FOUND'; end if;
  select status into v_author_status from public.author_pages
    where id = v_author_page_id for update;
  if v_author_status is distinct from 'active' then
    raise exception 'PRE_ORDER_MULTI_AUTHOR_UNAVAILABLE';
  end if;
  select * into v_campaign from public.author_preorder_campaigns
    where id = p_campaign_id and author_page_id = v_author_page_id for update;
  if not found or v_campaign.status <> 'active' or v_campaign.published_at is null
     or v_campaign.open_at is null or v_campaign.close_at is null
     or now() < v_campaign.open_at or now() >= v_campaign.close_at then
    raise exception 'PRE_ORDER_MULTI_NOT_OPEN';
  end if;

  if jsonb_typeof(v_campaign.delivery_company_keys) is distinct from 'array'
     or not (v_campaign.delivery_company_keys ? v_delivery_key) then
    raise exception 'PRE_ORDER_MULTI_DELIVERY_UNAVAILABLE';
  end if;
  if v_delivery_key in ('jnt','vet') then
    select coalesce(s.fee_usd,2::numeric),coalesce(s.is_active,true)
      into v_delivery_fee,v_delivery_active
      from (select 1) dummy left join public.author_store_delivery_settings s
        on s.author_page_id = v_author_page_id and s.company_key = v_delivery_key;
    if not v_delivery_active then raise exception 'PRE_ORDER_MULTI_DELIVERY_INACTIVE'; end if;
    v_delivery_name := case when v_delivery_key = 'jnt' then 'J&T Express' else 'VET Express' end;
  elsif v_delivery_key = 'custom' then
    select company_name,fee_usd,logo_url into v_delivery_name,v_delivery_fee,v_delivery_logo
    from public.author_store_custom_delivery_companies
    where author_page_id = v_author_page_id and is_active = true;
    if not found then raise exception 'PRE_ORDER_MULTI_DELIVERY_INACTIVE'; end if;
  else
    raise exception 'PRE_ORDER_MULTI_DELIVERY_INVALID';
  end if;
  if v_delivery_fee is null or v_delivery_fee < 0 or v_delivery_fee > 9999.99
     or length(coalesce(v_delivery_name,'')) not between 1 and 80 then
    raise exception 'PRE_ORDER_MULTI_DELIVERY_INVALID';
  end if;
  if v_signed and not v_campaign.signature_enabled then
    raise exception 'PRE_ORDER_MULTI_SIGNATURE_DISABLED';
  end if;
  v_signature_fee := case when v_signed then v_campaign.signature_fee_usd else 0 end;

  perform b.id from public.author_preorder_books b
    where b.campaign_id = p_campaign_id and b.id = any(v_book_ids)
    order by b.id for update;
  get diagnostics v_locked_count = row_count;
  if v_locked_count <> array_length(v_book_ids,1) then
    raise exception 'PRE_ORDER_MULTI_BOOK_NOT_FOUND';
  end if;

  for v_line in
    select value from jsonb_array_elements(p_payload->'items')
    order by value->>'book_id'
  loop
    v_book_id := (v_line->>'book_id')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    v_edition := v_line->>'edition';
    select * into v_book from public.author_preorder_books
      where id = v_book_id and campaign_id = p_campaign_id;
    if not found then raise exception 'PRE_ORDER_MULTI_BOOK_NOT_FOUND'; end if;
    select coalesce(sum(quantity),0) into v_legacy from public.author_preorder_stock_holds
      where book_id = v_book_id and edition = v_edition and status = 'held';
    select coalesce(sum(quantity),0) into v_held from public.author_preorder_volume_holds
      where book_id = v_book_id and edition = v_edition and status = 'held';
    if v_edition = 'standard' then
      if v_book.standard_enabled is not true then raise exception 'PRE_ORDER_MULTI_EDITION_DISABLED'; end if;
      v_unit_price := v_book.standard_price_usd;
      v_remaining := v_book.standard_quota::bigint - v_book.standard_reserved::bigint - v_legacy - v_held;
    else
      if v_book.limited_enabled is not true then raise exception 'PRE_ORDER_MULTI_EDITION_DISABLED'; end if;
      v_unit_price := v_book.limited_price_usd;
      v_remaining := v_book.limited_quota::bigint - v_book.limited_reserved::bigint - v_legacy - v_held;
    end if;
    if v_unit_price <= 0 or v_remaining < v_quantity then
      raise exception 'PRE_ORDER_MULTI_OUT_OF_STOCK';
    end if;
    v_subtotal := v_subtotal + v_unit_price * v_quantity;
  end loop;

  v_total := v_subtotal + v_signature_fee + v_delivery_fee;
  if v_total <= 0 or v_total > 9999999999.99 then
    raise exception 'PRE_ORDER_MULTI_TOTAL_INVALID';
  end if;
  v_expiry := clock_timestamp() + interval '15 minutes';
  insert into public.author_preorder_orders (
    author_page_id,campaign_id,buyer_user_id,payment_status,fulfillment_status,
    subtotal_usd,signature_fee_usd,delivery_fee_usd,total_usd,buyer_snapshot,
    delivery_snapshot,signature_requested,signature_name,buyer_note
  ) values (
    v_author_page_id,p_campaign_id,p_buyer_user_id,'pending','awaiting_payment',
    v_subtotal,v_signature_fee,v_delivery_fee,v_total,v_buyer,
    jsonb_build_object('address',v_buyer->>'delivery_address',
      'province_city',coalesce(v_buyer->>'province_city',''),
      'company',jsonb_build_object('company_key',v_delivery_key,
        'company_name',v_delivery_name,'fee_usd',v_delivery_fee,
        'logo_url',coalesce(v_delivery_logo,''))),
    v_signed,v_signature_name,v_buyer_note
  ) returning id into v_order_id;

  for v_line in
    select value from jsonb_array_elements(p_payload->'items')
    order by value->>'book_id'
  loop
    v_book_id := (v_line->>'book_id')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    v_edition := v_line->>'edition';
    select * into v_book from public.author_preorder_books where id = v_book_id;
    v_unit_price := case when v_edition='standard' then v_book.standard_price_usd else v_book.limited_price_usd end;
    insert into public.author_preorder_order_items (
      order_id,book_id,edition,quantity,unit_price_usd,book_title_snapshot
    ) values (v_order_id,v_book_id,v_edition,v_quantity,v_unit_price,v_book.title);
    insert into public.author_preorder_volume_holds (
      order_id,book_id,edition,quantity,held_at,expires_at
    ) values (v_order_id,v_book_id,v_edition,v_quantity,clock_timestamp(),v_expiry);
  end loop;

  insert into public.author_preorder_checkout_requests (
    buyer_user_id,request_key,order_id,request_sha256
  ) values (p_buyer_user_id,p_request_key,v_order_id,v_hash);

  return jsonb_build_object('order_id',v_order_id,'payment_status','pending',
    'total_usd',v_total,'reused',false,'inventory_held',true,
    'hold_status','held','hold_expires_at',v_expiry,
    'item_count',array_length(v_book_ids,1));
end;
$$;

revoke all on function public.author_preorder_create_multivolume_held_checkout(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.author_preorder_create_multivolume_held_checkout(uuid,uuid,uuid,jsonb)
  to service_role;
