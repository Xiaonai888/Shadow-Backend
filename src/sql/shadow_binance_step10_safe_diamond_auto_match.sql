-- SHADOW BINANCE / STEP 10
-- REPLACE existing public.auto_credit_binance_checkout_v1(int) with a
-- cross-purchase-safe version for Diamonds, Premium, PDF and future types.
--
-- Prerequisites: existing Diamond auto-credit SQL, Step 1 global receipt
-- claims, Step 8 universal purchase orders, Step 9 Premium fulfillment RPC.
--
-- Installing this SQL does NOT execute the RPC, send Telegram reports, or
-- credit anyone. Existing ABA functions, wallets and purchases are untouched.
-- Do NOT deploy workers with automatic universal fulfillment before finishing
-- the related checkout/controller work and testing the full pipeline.

begin;

create or replace function public.auto_credit_binance_checkout_v1(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_receipt public.binance_usdt_alert_transactions%rowtype;
  v_order public.binance_checkout_orders%rowtype;
  v_match_count integer;
  v_profile_count integer;
  v_receipt_count integer;
  v_any_order_matches integer;
  v_attempted integer := 0;
  v_credited integer := 0;
  v_result jsonb;
  v_credited_orders jsonb := '[]'::jsonb;
  v_now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  -- SELECT only transaction IDs first. Do NOT lock receipt rows here: the
  -- Premium RPC locks the advisory reference first, then the receipt row.
  -- Locking in that same order avoids Diamond/Premium worker deadlocks.
  for v_candidate in
    select r.transaction_id
    from public.binance_usdt_alert_transactions r
    where r.currency = 'USDT'
      and r.amount > 0
      and r.order_type in ('PAY', 'C2C')
      and r.payer_uid ~ '^[0-9]{5,20}$'
      and r.receiver_uid = '514018161'
      and r.transaction_time_ms >= v_now_ms - 24 * 60 * 60 * 1000
      and not exists (
        select 1 from public.shadow_binance_payment_claims c
        where c.provider = 'binance'
          and upper(btrim(c.transaction_id)) = upper(btrim(r.transaction_id))
      )
      and not exists (
        select 1 from public.admin_binance_usdt_credit_actions a
        where a.transaction_id = r.transaction_id
          or (a.action_type = 'topup'
            and upper(btrim(a.reference)) = upper(btrim(r.transaction_id)))
      )
      and not exists (
        select 1 from public.binance_checkout_orders o
        where o.verified_transaction_id = r.transaction_id
      )
      and not exists (
        select 1 from public.shadow_binance_purchase_orders o
        where o.verified_transaction_id = r.transaction_id
      )
      and exists (
        select 1
        from public.binance_checkout_orders o
        join public.reader_binance_payment_profiles p on p.user_id = o.user_id
        where o.status in ('waiting_payment', 'pending_review')
          and o.credited_at is null
          and o.verified_transaction_id is null
          and o.receiver_uid = r.receiver_uid
          and o.amount_usdt = r.amount
          and p.binance_uid = r.payer_uid
          and p.updated_at <= o.created_at
          and r.transaction_time_ms >= (extract(epoch from o.created_at) * 1000)::bigint - 60000
          and r.transaction_time_ms <= (extract(epoch from o.expires_at) * 1000)::bigint + 60000
          and clock_timestamp() <= o.created_at + interval '24 hours'
          and not exists (
            select 1 from public.binance_checkout_claims c
            where c.order_id = o.id and c.transaction_id <> r.transaction_id
          )
      )
    order by r.transaction_time_ms desc, r.transaction_id
    limit greatest(1, least(coalesce(p_limit, 10), 20))
  loop
    v_attempted := v_attempted + 1;

    -- Shared order with premium auto and manual credit recovery paths.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'admin-payment-reference:' || upper(btrim(v_candidate.transaction_id)), 0
      )
    );

    -- Receipt lock AFTER the global advisory lock, consistent with Premium.
    select * into v_receipt
    from public.binance_usdt_alert_transactions r
    where r.transaction_id = v_candidate.transaction_id
    for update of r skip locked;
    if not found then continue; end if;

    -- Recheck after acquiring locks: another process may have fulfilled it
    -- since the candidates were selected.
    if v_receipt.currency <> 'USDT'
      or v_receipt.amount <= 0
      or v_receipt.order_type not in ('PAY', 'C2C')
      or v_receipt.payer_uid !~ '^[0-9]{5,20}$'
      or v_receipt.receiver_uid <> '514018161'
      or v_receipt.transaction_time_ms < v_now_ms - 24 * 60 * 60 * 1000
      or exists (
        select 1 from public.shadow_binance_payment_claims c
        where c.provider = 'binance'
          and upper(btrim(c.transaction_id)) = upper(btrim(v_receipt.transaction_id))
      )
      or exists (
        select 1 from public.admin_binance_usdt_credit_actions a
        where a.transaction_id = v_receipt.transaction_id
          or (a.action_type = 'topup'
            and upper(btrim(a.reference)) = upper(btrim(v_receipt.transaction_id)))
      )
      or exists (
        select 1 from public.binance_checkout_orders o
        where o.verified_transaction_id = v_receipt.transaction_id
      )
      or exists (
        select 1 from public.shadow_binance_purchase_orders o
        where o.verified_transaction_id = v_receipt.transaction_id
      ) then
      continue;
    end if;

    -- Official payer Binance UID must uniquely identify ONE Shadow reader.
    select count(*) into v_profile_count
    from public.reader_binance_payment_profiles p
    where p.binance_uid = v_receipt.payer_uid;
    if v_profile_count <> 1 then continue; end if;

    -- Count ALL eligible checkouts for this receipt, regardless of purchase
    -- type. A 6-USDT payment could be either Diamonds $5 + fee or Premium
    -- 1-month $5 + fee. If both exist, neither may auto-release.
    select count(*) into v_any_order_matches
    from (
      select o.id
      from public.binance_checkout_orders o
      join public.reader_binance_payment_profiles p on p.user_id = o.user_id
      where o.status in ('waiting_payment', 'pending_review')
        and o.credited_at is null
        and o.verified_transaction_id is null
        and o.receiver_uid = v_receipt.receiver_uid
        and o.amount_usdt = v_receipt.amount
        and p.binance_uid = v_receipt.payer_uid
        and p.updated_at <= o.created_at
        and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at) * 1000)::bigint - 60000
        and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at) * 1000)::bigint + 60000
        and clock_timestamp() <= o.created_at + interval '24 hours'
        and not exists (
          select 1 from public.binance_checkout_claims c
          where c.order_id = o.id and c.transaction_id <> v_receipt.transaction_id
        )
      union all
      select o.id
      from public.shadow_binance_purchase_orders o
      join public.reader_binance_payment_profiles p on p.user_id = o.user_id
      where o.status in ('waiting_payment', 'pending_review')
        and o.fulfilled_at is null
        and o.verified_transaction_id is null
        and o.receiver_uid = v_receipt.receiver_uid
        and o.amount_usdt = v_receipt.amount
        and p.binance_uid = v_receipt.payer_uid
        and p.updated_at <= o.created_at
        and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at) * 1000)::bigint - 60000
        and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at) * 1000)::bigint + 60000
        and clock_timestamp() <= o.created_at + interval '24 hours'
    ) as all_checkout_matches;
    if v_any_order_matches <> 1 then continue; end if;

    -- Preserve the old Diamond checkout's exact-matching requirements.
    select count(*) into v_match_count
    from public.binance_checkout_orders o
    join public.reader_binance_payment_profiles p on p.user_id = o.user_id
    where o.status in ('waiting_payment', 'pending_review')
      and o.credited_at is null
      and o.verified_transaction_id is null
      and o.receiver_uid = v_receipt.receiver_uid
      and o.amount_usdt = v_receipt.amount
      and p.binance_uid = v_receipt.payer_uid
      and p.updated_at <= o.created_at
      and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at) * 1000)::bigint - 60000
      and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at) * 1000)::bigint + 60000
      and clock_timestamp() <= o.created_at + interval '24 hours'
      and not exists (
        select 1 from public.binance_checkout_claims c
        where c.order_id = o.id and c.transaction_id <> v_receipt.transaction_id
      );
    if v_match_count <> 1 then continue; end if;

    select o.* into v_order
    from public.binance_checkout_orders o
    join public.reader_binance_payment_profiles p on p.user_id = o.user_id
    where o.status in ('waiting_payment', 'pending_review')
      and o.credited_at is null
      and o.verified_transaction_id is null
      and o.receiver_uid = v_receipt.receiver_uid
      and o.amount_usdt = v_receipt.amount
      and p.binance_uid = v_receipt.payer_uid
      and p.updated_at <= o.created_at
      and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at) * 1000)::bigint - 60000
      and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at) * 1000)::bigint + 60000
      and clock_timestamp() <= o.created_at + interval '24 hours'
      and not exists (
        select 1 from public.binance_checkout_claims c
        where c.order_id = o.id and c.transaction_id <> v_receipt.transaction_id
      )
    -- SKIP LOCKED: Admin manual approval locks the order before requesting
    -- the reference advisory lock. Avoid waiting on that row here, or the
    -- two paths could deadlock while processing the same receipt.
    for update of o skip locked;
    if not found then continue; end if;

    -- Two distinct receipts from one sender for the same price/order window
    -- cannot be distinguished safely using amount + UID alone.
    select count(*) into v_receipt_count
    from public.binance_usdt_alert_transactions r
    where r.payer_uid = v_receipt.payer_uid
      and r.receiver_uid = v_receipt.receiver_uid
      and r.currency = 'USDT'
      and r.amount = v_receipt.amount
      and r.transaction_time_ms >= (extract(epoch from v_order.created_at) * 1000)::bigint - 60000
      and r.transaction_time_ms <= (extract(epoch from v_order.expires_at) * 1000)::bigint + 60000;
    if v_receipt_count <> 1 then continue; end if;

    -- Preserve the existing claim/approval RPCs. They atomically update the
    -- Diamond wallet, +100 Vouchers, receipt audit, and global receipt guard.
    perform public.submit_binance_checkout_claim_v1(
      v_order.user_id, v_order.id, v_receipt.transaction_id
    );
    v_result := public.approve_binance_checkout_admin_decision_v1(
      v_order.id,
      'binance-auto-verified',
      'binance-auto@system.invalid',
      'Automatic Binance payment: unique payer UID, receiver UID, amount, time, and purchase type verified.',
      true, true, true
    );
    if v_result->>'status' <> 'credited' then
      raise exception 'BINANCE_AUTO_CREDIT_FAILED';
    end if;
    if v_result->>'credit_applied' = 'true' then
      v_credited := v_credited + 1;
      v_credited_orders := v_credited_orders || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'order_id', v_order.id,
          'user_id', v_order.user_id,
          'diamonds', v_order.diamonds,
          'credited_at', clock_timestamp()
        )
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'checked', v_attempted,
    'credited', v_credited,
    'credited_orders', v_credited_orders
  );
end;
$$;

revoke all on function public.auto_credit_binance_checkout_v1(integer)
  from public, anon, authenticated;
grant execute on function public.auto_credit_binance_checkout_v1(integer)
  to service_role;

commit;

-- READ ONLY check; no credit or Telegram messages will be sent.
select
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'auto_credit_binance_checkout_v1') as diamond_auto_credit_rpc,
  (select count(*) from pg_trigger
   where tgname = 'shadow_binance_legacy_credit_once_v1'
     and not tgisinternal) as global_diamond_credit_guard,
  (select count(*) from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'shadow_binance_purchase_orders') as universal_orders_table;
