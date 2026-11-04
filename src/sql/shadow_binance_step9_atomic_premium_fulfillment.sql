-- Shadow Binance STEP 9: atomic, receipt-bound PREMIUM fulfillment.
-- NEW migration; apply after STEP 1 (global claims), STEP 5 (Telegram edit
-- queue), STEP 8 (universal purchase orders), and existing Premium schema.
--
-- SECURITY:
-- * This function is service_role-only, and only supports Premium orders.
-- * No payment is accepted from browser data or payer display names.
-- * A unique official payer UID, official receiver UID, exact USDT amount,
--   unique matching order, unique receipt in its window, and transaction
--   timestamp must all agree before ANY grant.
-- * The globally unique receipt claim, Diamonds, 100 Vouchers, Premium period,
--   notice, and fulfilled order are one PostgreSQL transaction. Failure rolls
--   back EVERY operation, including the Telegram edit-queue trigger.
-- * The additional 1 USDT remains a payment surcharge; Premium price and
--   rewards are checked against fixed server-side plan values.
-- * PDF/other products are FAIL-CLOSED here: their own atomic fulfillment
--   implementations must validate author-store orders and payouts first.
-- * This migration DOES NOT execute the function or issue entitlements.
-- * The Worker must call the RPC only after checkout creation is integrated.

begin;

create or replace function public.auto_fulfill_shadow_binance_premium_v1(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_receipt public.binance_usdt_alert_transactions%rowtype;
  v_order public.shadow_binance_purchase_orders%rowtype;
  v_updated public.shadow_binance_purchase_orders%rowtype;
  v_profile_count integer;
  v_order_match_count integer;
  v_receipt_match_count integer;
  v_plan_months integer;
  v_price numeric(18,2);
  v_base_diamonds integer;
  v_bonus_diamonds integer;
  v_diamonds integer;
  v_existing_expires timestamptz;
  v_existing_active boolean;
  v_base_expires timestamptz;
  v_now timestamptz;
  v_claimed boolean;
  v_notice_count integer;
  v_checked integer := 0;
  v_fulfilled integer := 0;
  v_grants jsonb := '[]'::jsonb;
  v_utc_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  for v_candidate in
    select r.transaction_id
    from public.binance_usdt_alert_transactions r
    where r.currency = 'USDT'
      and r.order_type in ('PAY', 'C2C')
      and r.payer_uid ~ '^[0-9]{5,20}$'
      and r.receiver_uid = '514018161'
      and r.amount > 1
      and r.transaction_time_ms >= v_utc_ms - 24 * 60 * 60 * 1000
      and not exists (
        select 1 from public.shadow_binance_payment_claims c
        where c.provider = 'binance'
          and upper(btrim(c.transaction_id)) = upper(btrim(r.transaction_id))
      )
      and exists (
        select 1
        from public.shadow_binance_purchase_orders o
        join public.reader_binance_payment_profiles p on p.user_id = o.user_id
        where o.purchase_kind = 'premium'
          and o.status in ('waiting_payment', 'pending_review')
          and o.verified_transaction_id is null
          and o.fulfilled_at is null
          and o.receiver_uid = r.receiver_uid
          and o.amount_usdt = r.amount
          and p.binance_uid = r.payer_uid
          and p.updated_at <= o.created_at
          and r.transaction_time_ms >= (extract(epoch from o.created_at) * 1000)::bigint - 60000
          and r.transaction_time_ms <= (extract(epoch from o.expires_at) * 1000)::bigint + 60000
          and clock_timestamp() <= o.created_at + interval '24 hours'
      )
    order by r.transaction_time_ms, r.transaction_id
    limit greatest(1, least(coalesce(p_limit, 10), 20))
  loop
    v_checked := v_checked + 1;

    -- This is the SAME lock namespace used by Diamond Admin/Auto recovery.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'admin-payment-reference:' || upper(btrim(v_candidate.transaction_id)), 0
      )
    );

    select * into v_receipt
    from public.binance_usdt_alert_transactions r
    where r.transaction_id = v_candidate.transaction_id
    for update;
    if not found
      or v_receipt.currency <> 'USDT'
      or v_receipt.order_type not in ('PAY','C2C')
      or v_receipt.receiver_uid <> '514018161'
      or v_receipt.payer_uid !~ '^[0-9]{5,20}$' then
      continue;
    end if;

    if exists (
      select 1 from public.shadow_binance_payment_claims c
      where c.provider = 'binance'
        and upper(btrim(c.transaction_id)) = upper(btrim(v_receipt.transaction_id))
    ) then
      continue;
    end if;

    -- One Binance UID must belong to exactly one reader account.
    select count(*) into v_profile_count
    from public.reader_binance_payment_profiles p
    where p.binance_uid = v_receipt.payer_uid;
    if v_profile_count <> 1 then continue; end if;

    -- A transfer must NOT match both a Diamond checkout and a Premium/PDF
    -- checkout (or two universal checkouts). Ambiguity requires review.
    select count(*) into v_order_match_count
    from (
      select o.id
      from public.shadow_binance_purchase_orders o
      join public.reader_binance_payment_profiles p on p.user_id = o.user_id
      where o.status in ('waiting_payment','pending_review')
        and o.verified_transaction_id is null
        and o.fulfilled_at is null
        and o.receiver_uid = v_receipt.receiver_uid
        and o.amount_usdt = v_receipt.amount
        and p.binance_uid = v_receipt.payer_uid
        and p.updated_at <= o.created_at
        and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at) * 1000)::bigint - 60000
        and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at) * 1000)::bigint + 60000
      union all
      select o.id
      from public.binance_checkout_orders o
      join public.reader_binance_payment_profiles p on p.user_id = o.user_id
      where o.status in ('waiting_payment','pending_review')
        and o.verified_transaction_id is null
        and o.credited_at is null
        and o.receiver_uid = v_receipt.receiver_uid
        and o.amount_usdt = v_receipt.amount
        and p.binance_uid = v_receipt.payer_uid
        and p.updated_at <= o.created_at
        and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at) * 1000)::bigint - 60000
        and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at) * 1000)::bigint + 60000
    ) matching_orders;
    if v_order_match_count <> 1 then continue; end if;

    select o.* into v_order
    from public.shadow_binance_purchase_orders o
    join public.reader_binance_payment_profiles p on p.user_id = o.user_id
    where o.purchase_kind = 'premium'
      and o.status in ('waiting_payment','pending_review')
      and o.verified_transaction_id is null
      and o.fulfilled_at is null
      and o.receiver_uid = v_receipt.receiver_uid
      and o.receiver_name = 'Shadow12226'
      and o.amount_usdt = v_receipt.amount
      and p.binance_uid = v_receipt.payer_uid
      and p.updated_at <= o.created_at
      and v_receipt.transaction_time_ms >= (extract(epoch from o.created_at) * 1000)::bigint - 60000
      and v_receipt.transaction_time_ms <= (extract(epoch from o.expires_at) * 1000)::bigint + 60000
      and clock_timestamp() <= o.created_at + interval '24 hours'
    for update of o;
    if not found then continue; end if;

    -- Two receipts from the same sender for the same price/window are
    -- ambiguous. Fail closed even if one receipt is already claimed.
    select count(*) into v_receipt_match_count
    from public.binance_usdt_alert_transactions r
    where r.currency = 'USDT'
      and r.order_type in ('PAY','C2C')
      and r.payer_uid = v_receipt.payer_uid
      and r.receiver_uid = v_receipt.receiver_uid
      and r.amount = v_receipt.amount
      and r.transaction_time_ms >= (extract(epoch from v_order.created_at) * 1000)::bigint - 60000
      and r.transaction_time_ms <= (extract(epoch from v_order.expires_at) * 1000)::bigint + 60000;
    if v_receipt_match_count <> 1 then continue; end if;

    -- The user-facing plan is NOT trusted: use fixed backend plan snapshots.
    -- Initial Premium checkout has no promotional discount. Support for
    -- discounted Premium plans must be added with explicit pricing rules.
    if (v_order.purchase_snapshot->>'plan_months') !~ '^(1|3|12)$'
      or v_order.promotion_discount_usd <> 0
      or v_order.author_income_usd is not null
      or v_order.bonus_vouchers <> 100 then
      continue;
    end if;

    v_plan_months := (v_order.purchase_snapshot->>'plan_months')::integer;
    case v_plan_months
      when 1 then v_price := 5.00; v_base_diamonds := 180; v_bonus_diamonds := 90;
      when 3 then v_price := 18.00; v_base_diamonds := 540; v_bonus_diamonds := 270;
      when 12 then v_price := 70.00; v_base_diamonds := 2200; v_bonus_diamonds := 1080;
      else continue;
    end case;
    v_diamonds := v_base_diamonds + v_bonus_diamonds;

    if v_order.list_price_usd <> v_price
      or v_order.payable_usd <> v_price
      or v_order.amount_usdt <> v_price + 1.00
      or (v_order.purchase_snapshot ? 'base_diamonds'
        and v_order.purchase_snapshot->>'base_diamonds' <> v_base_diamonds::text)
      or (v_order.purchase_snapshot ? 'bonus_diamonds'
        and v_order.purchase_snapshot->>'bonus_diamonds' <> v_bonus_diamonds::text) then
      continue;
    end if;

    -- Receipt consumption, reward updates and order status share this
    -- function's one PostgreSQL transaction; any exception rolls back all.
    v_claimed := public.claim_shadow_binance_receipt_once_v1(
      v_receipt.transaction_id,
      v_order.user_id,
      'premium',
      v_order.fulfillment_key,
      'universal_auto'
    );
    if v_claimed is distinct from true then continue; end if;

    v_now := clock_timestamp();

    insert into public.user_wallets (
      user_id, diamond_balance, gem_balance, voucher_balance
    ) values (v_order.user_id, 0, 0, 0)
    on conflict (user_id) do nothing;

    update public.user_wallets w
    set diamond_balance = coalesce(w.diamond_balance, 0) + v_diamonds,
        voucher_balance = coalesce(w.voucher_balance, 0) + 100,
        updated_at = v_now
    where w.user_id = v_order.user_id;
    if not found then
      raise exception 'BINANCE_PREMIUM_WALLET_NOT_FOUND';
    end if;

    select u.premium_expires_at, coalesce(u.is_premium, false)
      into v_existing_expires, v_existing_active
    from public.users u
    where u.id = v_order.user_id
    for update;
    if not found then
      raise exception 'BINANCE_PREMIUM_READER_NOT_FOUND';
    end if;

    v_base_expires := case
      when v_existing_active = true and v_existing_expires > v_now
        then v_existing_expires
      else v_now
    end;

    update public.users u
    set is_premium = true,
        premium_started_at = case
          when v_existing_active = true and v_existing_expires > v_now
            then coalesce(u.premium_started_at, v_now)
          else v_now
        end,
        premium_expires_at = v_base_expires + make_interval(months => v_plan_months),
        premium_plan_months = v_plan_months,
        updated_at = v_now
    where u.id = v_order.user_id;

    insert into public.reader_diamond_credit_notices (
      user_id, source_kind, source_id, diamonds, bonus_coins,
      bonus_vouchers, payment_method, created_at
    ) values (
      v_order.user_id, 'payment', v_order.id, v_diamonds, 0,
      100, 'binance_pay', v_now
    ) on conflict (source_kind, source_id) do nothing;
    get diagnostics v_notice_count = row_count;
    if v_notice_count <> 1 then
      raise exception 'BINANCE_PREMIUM_NOTICE_ALREADY_EXISTS';
    end if;

    update public.shadow_binance_purchase_orders o
    set status = 'fulfilled',
        verified_transaction_id = v_receipt.transaction_id,
        verified_at = v_now,
        fulfilled_at = v_now,
        updated_at = v_now
    where o.id = v_order.id
      and o.status in ('waiting_payment', 'pending_review')
      and o.verified_transaction_id is null
      and o.fulfilled_at is null
    returning * into v_updated;
    if not found then
      raise exception 'BINANCE_PREMIUM_ORDER_UPDATE_FAILED';
    end if;

    v_fulfilled := v_fulfilled + 1;
    v_grants := v_grants || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'order_id', v_updated.id,
        'user_id', v_updated.user_id,
        'purchase_kind', 'premium',
        'plan_months', v_plan_months,
        'diamonds', v_diamonds,
        'bonus_vouchers', 100,
        'amount_usdt', v_updated.amount_usdt,
        'fulfilled_at', v_now
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'checked', v_checked,
    'fulfilled', v_fulfilled,
    'fulfilled_orders', v_grants,
    'pdf_not_enabled', true
  );
end;
$$;

revoke all on function public.auto_fulfill_shadow_binance_premium_v1(integer)
  from public, anon, authenticated;
grant execute on function public.auto_fulfill_shadow_binance_premium_v1(integer)
  to service_role;

commit;

-- Setup check only; this does not perform payment matching or crediting.
select
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'auto_fulfill_shadow_binance_premium_v1') as premium_fulfillment_rpc,
  (select count(*) from public.shadow_binance_purchase_orders
   where purchase_kind = 'premium' and status = 'fulfilled') as fulfilled_premium_orders,
  (select count(*) from public.shadow_binance_payment_claims
   where purchase_kind = 'premium') as premium_receipts_claimed;
