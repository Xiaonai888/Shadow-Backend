begin;

-- Preserve all existing receipts, alerts, wallets and decisions.
alter table public.binance_usdt_alert_transactions
  add column if not exists payer_uid text not null default ''
    check (payer_uid = '' or payer_uid ~ '^[0-9]{5,20}$');
alter table public.binance_usdt_alert_transactions
  add column if not exists receiver_uid text not null default ''
    check (receiver_uid = '' or receiver_uid ~ '^[0-9]{5,20}$');

create index if not exists binance_usdt_receipt_identity_idx
  on public.binance_usdt_alert_transactions
  (payer_uid, receiver_uid, amount, transaction_time_ms)
  where payer_uid <> '' and receiver_uid <> '';

-- A receipt never credits a reader based on amount, time or similar names alone.
-- Only server-side calls (service_role) may attempt an automatic credit.
create or replace function public.auto_credit_binance_checkout_v1(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.binance_usdt_alert_transactions%rowtype;
  v_order public.binance_checkout_orders%rowtype;
  v_match_count integer;
  v_profile_count integer;
  v_receipt_count integer;
  v_attempted integer := 0;
  v_credited integer := 0;
  v_result jsonb;
  v_credited_orders jsonb := '[]'::jsonb;
  v_now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  for v_receipt in
    select r.*
    from public.binance_usdt_alert_transactions r
    where r.currency = 'USDT'
      and r.amount > 0
      and r.order_type in ('PAY', 'C2C')
      and r.payer_uid ~ '^[0-9]{5,20}$'
      and r.receiver_uid = '514018161'
      and r.transaction_time_ms >= v_now_ms - 24 * 60 * 60 * 1000
      and not exists (
        select 1 from public.admin_binance_usdt_credit_actions a
        where a.transaction_id = r.transaction_id
      )
      and not exists (
        select 1 from public.binance_checkout_orders o
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
    for update of r skip locked
  loop
    v_attempted := v_attempted + 1;

    -- Reader-provided UIDs must never overlap between different Shadow readers.
    select count(*) into v_profile_count
    from public.reader_binance_payment_profiles p
    where p.binance_uid = v_receipt.payer_uid;
    if v_profile_count <> 1 then
      continue;
    end if;

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
    if v_match_count <> 1 then
      continue;
    end if;

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
    for update of o;
    if not found then
      continue;
    end if;

    -- Different receipts with the same sender, amount and payment window
    -- are ambiguous, even if only one reader order currently remains active.
    select count(*) into v_receipt_count
    from public.binance_usdt_alert_transactions r
    where r.payer_uid = v_receipt.payer_uid
      and r.receiver_uid = v_receipt.receiver_uid
      and r.currency = 'USDT'
      and r.amount = v_receipt.amount
      and r.transaction_time_ms >= (extract(epoch from v_order.created_at) * 1000)::bigint - 60000
      and r.transaction_time_ms <= (extract(epoch from v_order.expires_at) * 1000)::bigint + 60000;
    if v_receipt_count <> 1 then
      continue;
    end if;

    -- The existing claim and approval RPCs perform the atomic wallet credit,
    -- voucher credit, receipt deduplication and financial audit insert.
    perform public.submit_binance_checkout_claim_v1(
      v_order.user_id, v_order.id, v_receipt.transaction_id
    );
    v_result := public.approve_binance_checkout_admin_decision_v1(
      v_order.id,
      'binance-auto-verified',
      'binance-auto@system.invalid',
      'Automatic Binance payment: official payer UID, receiver UID, amount, time and unique order verified.',
      true,
      true,
      true
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

  return jsonb_build_object('ok', true, 'checked', v_attempted, 'credited', v_credited, 'credited_orders', v_credited_orders);
end;
$$;

revoke all on function public.auto_credit_binance_checkout_v1(integer)
  from public, anon, authenticated;
grant execute on function public.auto_credit_binance_checkout_v1(integer)
  to service_role;

commit;
