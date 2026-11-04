-- Shadow Binance / STEP 8: common checkout order contract for Premium, PDF,
-- and future Binance purchase types. The existing Diamond checkout is unchanged.
-- Prerequisite: Step 1 Global Payment Claims, Step 5 Telegram Edit Queue,
-- and the existing official Binance receiver/reader profile schemas.
-- Financial safety: this migration does NOT create orders, charge payments,
-- grant Diamonds/Vouchers, activate Premium, unlock PDF, or send Telegram.
-- A future fulfillment RPC MUST reserve the central claim and deliver ALL
-- entitlements in the SAME PostgreSQL transaction before setting fulfilled.

begin;

create table if not exists public.shadow_binance_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete restrict,
  purchase_kind text not null
    check (purchase_kind ~ '^[a-z][a-z0-9_]{1,63}$'),
  fulfillment_key text not null unique
    check (char_length(btrim(fulfillment_key)) between 8 and 250),

  -- All amounts are immutable order-time snapshots, never client-supplied
  -- values for reward or author payout calculations.
  list_price_usd numeric(18,2) not null
    check (list_price_usd between 0.01 and 100000.00),
  promotion_discount_usd numeric(18,2) not null default 0
    check (promotion_discount_usd >= 0),
  payable_usd numeric(18,2) generated always as
    (list_price_usd - promotion_discount_usd) stored,
  binance_fee_usdt numeric(18,2) not null default 1.00
    check (binance_fee_usdt = 1.00),
  amount_usdt numeric(18,2) generated always as
    (list_price_usd - promotion_discount_usd + 1.00) stored,
  bonus_vouchers integer not null default 100
    check (bonus_vouchers = 100),

  -- Author revenue is a snapshot of the actual discounted book price.
  -- It must never include the additional Binance 1 USDT fee.
  author_income_usd numeric(18,2)
    check (author_income_usd is null or author_income_usd >= 0),
  purchase_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(purchase_snapshot) = 'object'
      and octet_length(purchase_snapshot::text) <= 16000),

  receiver_uid text not null check (receiver_uid ~ '^[0-9]{5,20}$'),
  receiver_name text not null
    check (char_length(btrim(receiver_name)) between 2 and 120),
  receiver_qr_sha256 text not null
    check (receiver_qr_sha256 ~ '^[a-f0-9]{64}$'),

  status text not null default 'waiting_payment'
    check (status in ('waiting_payment', 'pending_review',
      'fulfilled', 'expired', 'cancelled')),
  verified_transaction_id text
    references public.binance_usdt_alert_transactions(transaction_id),
  verified_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  updated_at timestamptz not null default now(),

  constraint shadow_binance_order_payable_positive_check
    check (list_price_usd - promotion_discount_usd >= 0.01),
  constraint shadow_binance_order_author_income_check
    check (author_income_usd is null
      or author_income_usd <= list_price_usd - promotion_discount_usd),
  constraint shadow_binance_order_checkout_window_check
    check (expires_at > created_at
      and expires_at <= created_at + interval '15 minutes'),
  constraint shadow_binance_order_fulfilled_evidence_check
    check (status <> 'fulfilled' or (
      verified_transaction_id is not null
      and verified_at is not null
      and fulfilled_at is not null
    ))
);

-- One completed payment cannot be connected to two orders (even if the
-- reference uses different letter case). The central claims table also
-- prevents cross-type usage, including existing Diamond orders.
create unique index if not exists shadow_binance_purchase_orders_receipt_once_uq
  on public.shadow_binance_purchase_orders
  (upper(btrim(verified_transaction_id)))
  where verified_transaction_id is not null;

-- Do not create two simultaneous generic checkout intents for one reader.
-- Existing Diamond checkouts remain separate until their controller is
-- integrated with this generic intent path.
create unique index if not exists shadow_binance_purchase_one_active_reader_uq
  on public.shadow_binance_purchase_orders(user_id)
  where status in ('waiting_payment', 'pending_review');

create index if not exists shadow_binance_purchase_reader_history_idx
  on public.shadow_binance_purchase_orders(user_id, created_at desc);
create index if not exists shadow_binance_purchase_review_idx
  on public.shadow_binance_purchase_orders(created_at, id)
  where status = 'pending_review';

alter table public.shadow_binance_purchase_orders enable row level security;
revoke all on public.shadow_binance_purchase_orders from public, anon, authenticated;
grant select, insert, update on public.shadow_binance_purchase_orders to service_role;

-- Block post-creation price, product, receiver, and author-income changes.
-- Additionally, a paid status must correspond to exactly one centrally
-- consumed official receipt with matching buyer, amount, sender UID,
-- receiver UID and transfer time. A status flag alone cannot bypass the guard.
create or replace function public.guard_shadow_binance_purchase_order_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.binance_usdt_alert_transactions%rowtype;
  v_uid text;
  v_profile_updated timestamptz;
  v_count integer;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.purchase_kind is distinct from old.purchase_kind
      or new.fulfillment_key is distinct from old.fulfillment_key
      or new.list_price_usd is distinct from old.list_price_usd
      or new.promotion_discount_usd is distinct from old.promotion_discount_usd
      or new.binance_fee_usdt is distinct from old.binance_fee_usdt
      or new.bonus_vouchers is distinct from old.bonus_vouchers
      or new.author_income_usd is distinct from old.author_income_usd
      or new.purchase_snapshot is distinct from old.purchase_snapshot
      or new.receiver_uid is distinct from old.receiver_uid
      or new.receiver_name is distinct from old.receiver_name
      or new.receiver_qr_sha256 is distinct from old.receiver_qr_sha256
      or new.created_at is distinct from old.created_at
      or new.expires_at is distinct from old.expires_at then
      raise exception 'BINANCE_ORDER_SNAPSHOT_IMMUTABLE';
    end if;

    if old.status in ('fulfilled', 'expired', 'cancelled')
       and (new.status is distinct from old.status
         or new.verified_transaction_id is distinct from old.verified_transaction_id
         or new.verified_at is distinct from old.verified_at
         or new.fulfilled_at is distinct from old.fulfilled_at) then
      raise exception 'BINANCE_ORDER_TERMINAL_STATE_IMMUTABLE';
    end if;

    if old.status = 'pending_review' and new.status = 'waiting_payment' then
      raise exception 'BINANCE_ORDER_CANNOT_REOPEN_PENDING_PAYMENT';
    end if;
  end if;

  if new.status = 'fulfilled' and (new.fulfilled_at is null
     or new.verified_at is null or new.fulfilled_at < new.verified_at) then
    raise exception 'BINANCE_FULFILLMENT_TIMELINE_INVALID';
  end if;

  if new.status <> 'fulfilled' then
    if new.verified_transaction_id is not null
      or new.verified_at is not null or new.fulfilled_at is not null then
      raise exception 'BINANCE_UNFULFILLED_ORDER_HAS_FULFILLMENT_EVIDENCE';
    end if;
    return new;
  end if;

  -- The fulfillment RPC must insert this global claim FIRST, but all changes
  -- must remain in its single DB transaction (rollback on any failure).
  if not exists (
    select 1 from public.shadow_binance_payment_claims c
    where c.provider = 'binance'
      and upper(btrim(c.transaction_id)) = upper(btrim(new.verified_transaction_id))
      and c.user_id = new.user_id
      and c.purchase_kind = new.purchase_kind
      and c.fulfillment_key = new.fulfillment_key
  ) then
    raise exception 'BINANCE_CENTRAL_RECEIPT_CLAIM_REQUIRED';
  end if;

  select * into v_receipt
  from public.binance_usdt_alert_transactions r
  where r.transaction_id = new.verified_transaction_id;
  if not found or v_receipt.currency <> 'USDT'
    or v_receipt.amount is distinct from new.amount_usdt
    or v_receipt.receiver_uid is distinct from new.receiver_uid
    or v_receipt.order_type not in ('PAY', 'C2C') then
    raise exception 'BINANCE_RECEIPT_AMOUNT_OR_RECEIVER_MISMATCH';
  end if;

  -- Never infer buyer identity from Binance display names or matching amounts.
  select p.binance_uid,p.updated_at into v_uid,v_profile_updated
  from public.reader_binance_payment_profiles p
  where p.user_id = new.user_id;
  select count(*) into v_count
  from public.reader_binance_payment_profiles p
  where p.binance_uid = v_uid and v_uid <> '';
  if nullif(v_uid, '') is null or v_count <> 1
    or v_profile_updated is null or v_profile_updated > new.created_at
    or v_receipt.payer_uid is distinct from v_uid then
    raise exception 'BINANCE_VERIFIED_PAYER_UID_REQUIRED';
  end if;

  if v_receipt.transaction_time_ms <
       (extract(epoch from new.created_at) * 1000 - 60000)::bigint
    or v_receipt.transaction_time_ms >
       (extract(epoch from new.expires_at) * 1000 + 60000)::bigint then
    raise exception 'BINANCE_RECEIPT_TIME_WINDOW_MISMATCH';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_shadow_binance_purchase_order_v1()
  from public, anon, authenticated;

drop trigger if exists shadow_binance_purchase_order_guard_v1
  on public.shadow_binance_purchase_orders;
create trigger shadow_binance_purchase_order_guard_v1
  before insert or update on public.shadow_binance_purchase_orders
  for each row execute function public.guard_shadow_binance_purchase_order_v1();

commit;

-- Read-only setup check. Zero orders is correct before checkout is enabled.
select
  (select count(*) from public.shadow_binance_purchase_orders) as purchase_orders,
  (select count(*) from pg_trigger
   where tgrelid = 'public.shadow_binance_purchase_orders'::regclass
     and tgname = 'shadow_binance_purchase_order_guard_v1'
     and not tgisinternal) as active_order_guard,
  (select count(*) from pg_indexes
   where schemaname = 'public'
     and tablename = 'shadow_binance_purchase_orders'
     and indexname = 'shadow_binance_purchase_orders_receipt_once_uq') as unique_receipt_index,
  (select count(*) from pg_indexes
   where schemaname = 'public'
     and tablename = 'shadow_binance_purchase_orders'
     and indexname = 'shadow_binance_purchase_one_active_reader_uq') as active_checkout_index;
