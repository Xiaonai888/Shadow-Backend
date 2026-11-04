-- Shadow Binance / STEP 15: Author Store PDF checkout and atomic fulfillment.
-- Prerequisites: Steps 1, 5, 8, 10; author-store schema and Binance receipts.
-- IMPORTANT: Install before enabling PDF Binance in Admin Country Settings.
-- Only service_role may call these functions. No entitlement is granted on
-- checkout creation. A verified receipt is consumed in the SAME DB transaction
-- as PDF grants, wallet voucher bonus and order finalization.

begin;

-- Validate the *live* database schema before installing the RPC. This catches
-- missing old Author Store migrations BEFORE any checkout can be accepted.
do $$
declare
  check_row record;
begin
  for check_row in
    select * from (values
      ('author_store_orders','id'),('author_store_orders','buyer_id'),
      ('author_store_orders','author_page_id'),('author_store_orders','order_id'),
      ('author_store_orders','order_number'),('author_store_orders','cart_signature'),
      ('author_store_orders','items'),('author_store_orders','buyer_profile'),
      ('author_store_orders','buyer_name'),('author_store_orders','buyer_phone'),
      ('author_store_orders','buyer_email'),('author_store_orders','delivery_address'),
      ('author_store_orders','subtotal'),('author_store_orders','delivery_fee'),
      ('author_store_orders','total_amount'),('author_store_orders','subtotal_usd'),
      ('author_store_orders','delivery_fee_usd'),('author_store_orders','total_usd'),
      ('author_store_orders','product_subtotal_usd'),
      ('author_store_orders','platform_fee_rate'),('author_store_orders','platform_fee_usd'),
      ('author_store_orders','author_income_usd'),('author_store_orders','currency'),
      ('author_store_orders','status'),('author_store_orders','payment_status'),
      ('author_store_orders','order_status'),('author_store_orders','request_payload'),
      ('author_store_orders','aba_payload'),('author_store_orders','expires_at'),
      ('author_store_orders','updated_at'),('author_store_orders','paid_at'),
      ('author_store_orders','confirmed_at'),('author_store_orders','pdf_unlock_status'),
      ('author_store_orders','pdf_unlocked_at'),('author_store_orders','pdf_unlock_count'),
      ('author_store_order_items','order_id'),('author_store_order_items','product_id'),
      ('author_store_order_items','product_title'),('author_store_order_items','product_type'),
      ('author_store_order_items','cover_url'),('author_store_order_items','quantity'),
      ('author_store_order_items','unit_price'),('author_store_order_items','total_price'),
      ('author_store_order_items','platform_fee_rate'),
      ('author_store_order_items','platform_fee_usd'),
      ('author_store_order_items','author_income_usd'),
      ('author_store_products','id'),('author_store_products','author_page_id'),
      ('author_store_products','status'),('author_store_products','product_type'),
      ('author_store_products','pdf_storage_key'),('author_store_products','pdf_file_url'),
      ('author_store_products','pdf_file_name'),('author_store_products','access_rule'),
      ('author_store_products','title'),('author_store_products','cover_url'),
      ('author_store_reader_downloads','buyer_id'),
      ('author_store_reader_downloads','product_id'),
      ('author_store_reader_downloads','author_page_id'),
      ('author_store_reader_downloads','order_id'),
      ('author_store_reader_downloads','order_number'),
      ('author_store_reader_downloads','title'),('author_store_reader_downloads','cover_url'),
      ('author_store_reader_downloads','pdf_file_url'),
      ('author_store_reader_downloads','pdf_file_name'),
      ('author_store_reader_downloads','access_rule'),
      ('shadow_binance_purchase_orders','id'),
      ('shadow_binance_purchase_orders','purchase_snapshot'),
      ('shadow_binance_purchase_orders','amount_usdt'),
      ('shadow_binance_purchase_orders','author_income_usd'),
      ('reader_binance_payment_profiles','binance_uid'),
      ('reader_binance_payment_profiles','updated_at'),
      ('binance_usdt_alert_transactions','payer_uid'),
      ('binance_usdt_alert_transactions','receiver_uid'),
      ('binance_usdt_alert_transactions','transaction_time_ms'),
      ('user_wallets','voucher_balance')
    ) as v(table_name,col_name)
  loop
    if pg_catalog.to_regclass('public.'||check_row.table_name) is null
      or not exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid=pg_catalog.to_regclass('public.'||check_row.table_name)
          and a.attname=check_row.col_name and a.attnum>0 and not a.attisdropped
      ) then
      raise exception 'BINANCE_PDF_SCHEMA_MISSING: %.%',check_row.table_name,check_row.col_name;
    end if;
  end loop;
  if pg_catalog.to_regprocedure(
    'public.claim_shadow_binance_receipt_once_v1(text,uuid,text,text,text)'
  ) is null then
    raise exception 'BINANCE_PDF_MISSING_GLOBAL_RECEIPT_CLAIM';
  end if;
end;
$$;

create or replace function public.create_shadow_binance_pdf_checkout_v1(p jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_author uuid;
  v_purchase uuid := pg_catalog.gen_random_uuid();
  v_author_order uuid;
  v_public_id text;
  v_items jsonb;
  v_subtotal numeric(18,2);
  v_fee numeric(18,2);
  v_income numeric(18,2);
  v_real_subtotal numeric(18,2);
  v_real_fee numeric(18,2);
  v_item_count int;
  v_invalid int;
  v_now timestamptz := clock_timestamp();
  v_expiry timestamptz;
  v_receiver_uid text;
  v_receiver_name text;
  v_receiver_hash text;
  v_profile_count int;
  v_snapshot jsonb;
begin
  if pg_catalog.jsonb_typeof(p) <> 'object' or pg_catalog.octet_length(p::text) > 32000 then
    raise exception 'BINANCE_PDF_INVALID_CHECKOUT_BODY';
  end if;
  v_user := (p->>'user_id')::uuid;
  v_author := (p->>'author_page_id')::uuid;
  v_public_id := btrim(p->>'order_public_id');
  v_items := p->'items';
  v_subtotal := (p->>'subtotal_usd')::numeric(18,2);
  v_fee := (p->>'platform_fee_usd')::numeric(18,2);
  v_income := (p->>'author_income_usd')::numeric(18,2);
  v_receiver_uid := coalesce(p->>'receiver_uid','');
  v_receiver_name := coalesce(p->>'receiver_name','');
  v_receiver_hash := coalesce(p->>'receiver_qr_sha256','');
  if v_user is null or v_author is null or v_public_id !~ '^A[A-Z0-9]{8,19}$'
     or v_receiver_uid <> '514018161' or v_receiver_name <> 'Shadow12226'
     or v_receiver_hash !~ '^[a-f0-9]{64}$'
     or v_subtotal not between 0.01 and 100000.00
     or v_fee < 0 or v_income < 0 or v_subtotal <> v_fee + v_income
     or pg_catalog.jsonb_typeof(v_items) <> 'array'
     or pg_catalog.jsonb_array_length(v_items) not between 1 and 30 then
    raise exception 'BINANCE_PDF_INVALID_CHECKOUT_SNAPSHOT';
  end if;

  -- One checkout writer per reader; the table's partial unique index is a
  -- second, database-enforced guard against accidental double creation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('binance-universal-intent:' || v_user::text,0)
  );
  if exists (select 1 from public.shadow_binance_purchase_orders o
             where o.user_id=v_user and o.status in ('waiting_payment','pending_review')) then
    raise exception 'BINANCE_PDF_ACTIVE_UNIVERSAL_ORDER';
  end if;
  if exists (select 1 from public.binance_checkout_orders o
             where o.user_id=v_user and o.status in ('waiting_payment','pending_review')
               and o.created_at > v_now - interval '24 hours') then
    raise exception 'BINANCE_PDF_ACTIVE_DIAMOND_ORDER';
  end if;
  select count(*) into v_profile_count from public.reader_binance_payment_profiles r
    where r.user_id=v_user and r.binance_uid ~ '^[0-9]{5,20}$'
      and not exists (select 1 from public.reader_binance_payment_profiles other
        where other.user_id <> v_user and other.binance_uid = r.binance_uid);
  if v_profile_count <> 1 then raise exception 'BINANCE_PDF_PAYER_UID_NOT_UNIQUE'; end if;

  select count(*), coalesce(sum((i.value->>'total_usd')::numeric),0)::numeric(18,2),
         coalesce(sum((i.value->>'platform_fee_usd')::numeric),0)::numeric(18,2)
  into v_item_count, v_real_subtotal, v_real_fee
  from pg_catalog.jsonb_array_elements(v_items) i;
  if v_item_count <> pg_catalog.jsonb_array_length(v_items)
      or v_real_subtotal <> v_subtotal or v_real_fee <> v_fee then
    raise exception 'BINANCE_PDF_ITEMS_TOTAL_MISMATCH';
  end if;

  -- Validate every PDF, its author page, and durable downloadable private file.
  -- Prices and promotional author-fee snapshots were computed server-side by
  -- the existing Author Store pricing and promotion services (not the reader).
  select count(*) into v_invalid
  from pg_catalog.jsonb_to_recordset(v_items)
       as i(product_id uuid, product_type text, quantity int, total_usd numeric,
            platform_fee_usd numeric, author_income_usd numeric) 
  left join public.author_store_products product on product.id = i.product_id
  where product.id is null or product.author_page_id <> v_author
     or product.status <> 'active' or product.product_type <> 'pdf'
     or (coalesce(product.pdf_storage_key,'') = '' and coalesce(product.pdf_file_url,'') = '')
     or i.product_type is distinct from 'pdf' or i.quantity is null or i.quantity not between 1 and 99
     or i.total_usd is null or i.total_usd < 0
     or i.platform_fee_usd is null or i.platform_fee_usd < 0
     or i.author_income_usd is null or i.author_income_usd < 0
     or round(i.platform_fee_usd + i.author_income_usd,2) <> round(i.total_usd,2);
  if v_invalid <> 0 or (select count(distinct x->>'product_id')
                        from pg_catalog.jsonb_array_elements(v_items) x) <> v_item_count then
    raise exception 'BINANCE_PDF_PRODUCT_VALIDATION_FAILED';
  end if;

  v_expiry := v_now + interval '15 minutes';
  v_snapshot := pg_catalog.jsonb_build_object(
     'author_page_id',v_author::text,
     'cart_signature',btrim(coalesce(p->>'cart_signature','')),
     'items_count',v_item_count,
     'author_income_usd',v_income,
     'platform_fee_usd',v_fee,
     'source','author_store',
     'payment_method','binance_personal_pay'
  );

  -- Insert the author order, line items, and universal intent in one function.
  -- Any exception rolls ALL three back (no orphan order / PDF entitlement).
  insert into public.author_store_orders (
    author_page_id,buyer_id,order_id,order_number,cart_signature,items,
    buyer_profile,buyer_name,buyer_phone,buyer_email,delivery_address,
    subtotal,delivery_fee,total_amount,subtotal_usd,delivery_fee_usd,total_usd,
    product_subtotal_usd,platform_fee_rate,platform_fee_usd,author_income_usd,
    currency,status,payment_status,order_status,request_payload,aba_payload,
    expires_at,updated_at
  ) values (
    v_author,v_user,v_public_id,v_public_id,btrim(coalesce(p->>'cart_signature','')),v_items,
    coalesce(p->'buyer_profile','{}'::jsonb),
    coalesce(p->>'buyer_name',''),'',coalesce(p->>'buyer_email',''),'',
    v_subtotal,0,v_subtotal,v_subtotal,0,v_subtotal,
    v_subtotal,0.10,v_fee,v_income,
    'USD','waiting_payment','pending','waiting_payment',
    pg_catalog.jsonb_build_object(
      'payment_method','binance_personal_pay',
      'binance_purchase_id',v_purchase::text,
      'checkout_attribution',coalesce(p->'checkout_attribution','{}'::jsonb)
    ),'{}'::jsonb,v_expiry,v_now
  ) returning id into v_author_order;

  insert into public.author_store_order_items (
    order_id,product_id,product_title,product_type,cover_url,quantity,
    unit_price,total_price,platform_fee_rate,platform_fee_usd,author_income_usd
  )
  select v_author_order,i.product_id,i.product_title,'pdf',coalesce(i.cover_url,''),
         i.quantity,i.unit_price_usd,i.total_usd,i.platform_fee_rate,
         i.platform_fee_usd,i.author_income_usd
  from pg_catalog.jsonb_to_recordset(v_items) as i (
    product_id uuid,product_title text,cover_url text,quantity int,
    unit_price_usd numeric,total_usd numeric,platform_fee_rate numeric,
    platform_fee_usd numeric,author_income_usd numeric
  );

  v_snapshot := v_snapshot || pg_catalog.jsonb_build_object(
    'author_order_id',v_author_order::text,'author_order_number',v_public_id
  );

  insert into public.shadow_binance_purchase_orders (
    id,user_id,purchase_kind,fulfillment_key,list_price_usd,
    promotion_discount_usd,binance_fee_usdt,bonus_vouchers,author_income_usd,
    purchase_snapshot,receiver_uid,receiver_name,receiver_qr_sha256,
    status,created_at,expires_at,updated_at
  ) values (
    v_purchase,v_user,'pdf','binance:pdf:' || v_purchase::text,v_subtotal,
    0,1,100,v_income,v_snapshot,
    v_receiver_uid,v_receiver_name,v_receiver_hash,'waiting_payment',v_now,v_expiry,v_now
  );

  return pg_catalog.jsonb_build_object(
    'ok',true,'purchase_id',v_purchase,'author_order_id',v_author_order,
    'author_order_number',v_public_id,'amount_usdt',v_subtotal+1,
    'price_usd',v_subtotal,'expires_at',v_expiry
  );
end;
$$;
revoke all on function public.create_shadow_binance_pdf_checkout_v1(jsonb) from public,anon,authenticated;
grant execute on function public.create_shadow_binance_pdf_checkout_v1(jsonb) to service_role;

create or replace function public.auto_fulfill_shadow_binance_pdf_v1(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_candidate record;
  v_receipt public.binance_usdt_alert_transactions%rowtype;
  v_order public.shadow_binance_purchase_orders%rowtype;
  v_author public.author_store_orders%rowtype;
  v_now timestamptz;
  v_profiles int;
  v_orders int;
  v_receipts int;
  v_grants int;
  v_expected int;
  v_claimed bool;
  v_checked int := 0;
  v_fulfilled int := 0;
  v_results jsonb := '[]'::jsonb;
  v_cutoff_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint - 86400000;
begin
  for v_candidate in
    select r.transaction_id
    from public.binance_usdt_alert_transactions r
    where r.currency='USDT' and r.order_type in ('PAY','C2C')
      and r.receiver_uid='514018161' and r.payer_uid ~ '^[0-9]{5,20}$'
      and r.transaction_time_ms >= v_cutoff_ms and r.amount > 1
      and not exists (select 1 from public.shadow_binance_payment_claims c
        where c.provider='binance' and upper(btrim(c.transaction_id))=upper(btrim(r.transaction_id)))
      and exists (
        select 1 from public.shadow_binance_purchase_orders o
        join public.reader_binance_payment_profiles p on p.user_id=o.user_id
        where o.purchase_kind='pdf' and o.status in ('waiting_payment','pending_review')
          and o.verified_transaction_id is null and o.fulfilled_at is null
          and o.receiver_uid=r.receiver_uid and o.amount_usdt=r.amount
          and p.binance_uid=r.payer_uid and p.updated_at <= o.created_at
          and r.transaction_time_ms >= (extract(epoch from o.created_at)*1000)::bigint-60000
          and r.transaction_time_ms <= (extract(epoch from o.expires_at)*1000)::bigint+60000
          and clock_timestamp() <= o.created_at + interval '24 hours'
      )
    order by r.transaction_time_ms,r.transaction_id
    limit greatest(1,least(coalesce(p_limit,10),20))
  loop
    v_checked := v_checked + 1;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('admin-payment-reference:' || upper(btrim(v_candidate.transaction_id)),0)
    );
    select * into v_receipt from public.binance_usdt_alert_transactions
      where transaction_id=v_candidate.transaction_id for update;
    if not found or v_receipt.currency <> 'USDT' or v_receipt.order_type not in ('PAY','C2C')
      or v_receipt.receiver_uid <> '514018161' or v_receipt.payer_uid !~ '^[0-9]{5,20}$' then
      continue;
    end if;
    if exists (select 1 from public.shadow_binance_payment_claims c
        where c.provider='binance' and upper(btrim(c.transaction_id))=upper(btrim(v_receipt.transaction_id))) then
      continue;
    end if;

    select count(*) into v_profiles from public.reader_binance_payment_profiles p
      where p.binance_uid=v_receipt.payer_uid;
    if v_profiles<>1 then continue; end if;

    -- Cross-kind uniqueness: exactly one intent for this payer, amount, time.
    select count(*) into v_orders from (
      select o.id from public.shadow_binance_purchase_orders o
      join public.reader_binance_payment_profiles p on p.user_id=o.user_id
      where o.status in ('waiting_payment','pending_review')
        and o.verified_transaction_id is null and o.fulfilled_at is null
        and o.receiver_uid=v_receipt.receiver_uid and o.amount_usdt=v_receipt.amount
        and p.binance_uid=v_receipt.payer_uid and p.updated_at <= o.created_at
        and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at)*1000)::bigint-60000
        and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at)*1000)::bigint+60000
      union all
      select o.id from public.binance_checkout_orders o
      join public.reader_binance_payment_profiles p on p.user_id=o.user_id
      where o.status in ('waiting_payment','pending_review')
        and o.verified_transaction_id is null and o.credited_at is null
        and o.receiver_uid=v_receipt.receiver_uid and o.amount_usdt=v_receipt.amount
        and p.binance_uid=v_receipt.payer_uid and p.updated_at <= o.created_at
        and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at)*1000)::bigint-60000
        and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at)*1000)::bigint+60000
    ) all_orders;
    if v_orders <> 1 then continue; end if;

    select o.* into v_order from public.shadow_binance_purchase_orders o
    join public.reader_binance_payment_profiles p on p.user_id=o.user_id
    where o.purchase_kind='pdf' and o.status in ('waiting_payment','pending_review')
      and o.verified_transaction_id is null and o.fulfilled_at is null
      and o.receiver_uid=v_receipt.receiver_uid and o.receiver_name='Shadow12226'
      and o.amount_usdt=v_receipt.amount and o.bonus_vouchers=100
      and p.binance_uid=v_receipt.payer_uid and p.updated_at <= o.created_at
      and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at)*1000)::bigint-60000
      and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at)*1000)::bigint+60000
      and clock_timestamp() <= o.created_at + interval '24 hours'
    for update of o;
    if not found then continue; end if;

    select count(*) into v_receipts from public.binance_usdt_alert_transactions r
    where r.currency='USDT' and r.order_type in ('PAY','C2C')
      and r.payer_uid=v_receipt.payer_uid and r.receiver_uid=v_receipt.receiver_uid
      and r.amount=v_receipt.amount
      and r.transaction_time_ms >= (extract(epoch from v_order.created_at)*1000)::bigint-60000
      and r.transaction_time_ms <= (extract(epoch from v_order.expires_at)*1000)::bigint+60000;
    if v_receipts <> 1 then continue; end if;

    select * into v_author from public.author_store_orders a
    where a.id=(v_order.purchase_snapshot->>'author_order_id')::uuid
      and a.buyer_id=v_order.user_id
      and a.author_page_id=(v_order.purchase_snapshot->>'author_page_id')::uuid
      and a.status='waiting_payment' and a.payment_status='pending'
      and a.total_usd=v_order.payable_usd
      and a.author_income_usd=v_order.author_income_usd
      and a.request_payload->>'payment_method'='binance_personal_pay'
      and a.request_payload->>'binance_purchase_id'=v_order.id::text
    for update;
    if not found then continue; end if;
    select count(*) into v_expected from public.author_store_order_items i
      join public.author_store_products product on product.id=i.product_id
      where i.order_id=v_author.id and i.product_type='pdf'
        and product.product_type='pdf' and product.author_page_id=v_author.author_page_id
        and (coalesce(product.pdf_storage_key,'')<>'' or coalesce(product.pdf_file_url,'')<>'');
    if v_expected=0 or v_expected <> (select count(*) from public.author_store_order_items i
                                         where i.order_id=v_author.id) then
      continue;
    end if;

    v_claimed := public.claim_shadow_binance_receipt_once_v1(
      v_receipt.transaction_id,v_order.user_id,'pdf',v_order.fulfillment_key,'universal_auto'
    );
    if v_claimed is distinct from true then continue; end if;
    v_now := clock_timestamp();

    insert into public.user_wallets (user_id,diamond_balance,gem_balance,voucher_balance)
      values (v_order.user_id,0,0,0) on conflict(user_id) do nothing;
    update public.user_wallets set voucher_balance=coalesce(voucher_balance,0)+100,
      updated_at=v_now where user_id=v_order.user_id;
    if not found then raise exception 'BINANCE_PDF_VOUCHER_GRANT_FAILED'; end if;

    insert into public.author_store_reader_downloads (
      buyer_id,author_page_id,product_id,order_id,order_number,title,
      cover_url,pdf_file_url,pdf_file_name,access_rule
    )
    select v_order.user_id,product.author_page_id,product.id,v_author.id,
           v_author.order_id,product.title,product.cover_url,
           coalesce(product.pdf_file_url,''),coalesce(product.pdf_file_name,product.title||'.pdf'),
           coalesce(product.access_rule,'download')
      from public.author_store_order_items i
      join public.author_store_products product on product.id=i.product_id
     where i.order_id=v_author.id and i.product_type='pdf'
    on conflict (buyer_id,product_id) do update set
      order_id=excluded.order_id,order_number=excluded.order_number,
      title=excluded.title,cover_url=excluded.cover_url,
      pdf_file_url=excluded.pdf_file_url,pdf_file_name=excluded.pdf_file_name,
      access_rule=excluded.access_rule;
    get diagnostics v_grants = row_count;
    if v_grants <> v_expected then
      raise exception 'BINANCE_PDF_DOWNLOAD_GRANTS_INCOMPLETE';
    end if;

    update public.author_store_orders a set
      status='confirmed',order_status='confirmed',payment_status='paid',
      paid_at=v_now,confirmed_at=v_now,pdf_unlock_status='unlocked',
      pdf_unlocked_at=v_now,pdf_unlock_count=v_grants,updated_at=v_now
    where a.id=v_author.id and a.status='waiting_payment'
      and a.payment_status='pending';
    if not found then raise exception 'BINANCE_PDF_AUTHOR_ORDER_FULFILL_FAILED'; end if;

    -- PDF grants contain vouchers only. Do NOT insert into
    -- reader_diamond_credit_notices: that table CHECKs diamonds > 0.
    -- The confirmed wallet voucher credit and global receipt claim remain
    -- durable evidence. A separate voucher-only notice UI can be added later.

    update public.shadow_binance_purchase_orders o set
      status='fulfilled',verified_transaction_id=v_receipt.transaction_id,
      verified_at=v_now,fulfilled_at=v_now,updated_at=v_now
    where o.id=v_order.id and o.status in ('waiting_payment','pending_review')
      and o.verified_transaction_id is null and o.fulfilled_at is null;
    if not found then raise exception 'BINANCE_PDF_PURCHASE_FULFILL_FAILED'; end if;

    v_fulfilled := v_fulfilled + 1;
    v_results := v_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'order_id',v_order.id,'author_order_id',v_author.id,'author_order_number',v_author.order_id,
      'user_id',v_order.user_id,'purchase_kind','pdf','bonus_vouchers',100,
      'amount_usdt',v_order.amount_usdt,'fulfilled_at',v_now
    ));
  end loop;
  return pg_catalog.jsonb_build_object(
    'ok',true,'checked',v_checked,'fulfilled',v_fulfilled,'fulfilled_orders',v_results
  );
end;
$$;
revoke all on function public.auto_fulfill_shadow_binance_pdf_v1(integer) from public,anon,authenticated;
grant execute on function public.auto_fulfill_shadow_binance_pdf_v1(integer) to service_role;

commit;

-- Read-only setup check: no checkout, no credit, no new claims.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='create_shadow_binance_pdf_checkout_v1') as pdf_create_rpc,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='auto_fulfill_shadow_binance_pdf_v1') as pdf_fulfill_rpc;
