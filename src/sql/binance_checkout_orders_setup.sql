begin;

create table if not exists public.binance_checkout_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete restrict,
  package_usd integer not null check (package_usd in (1, 5, 10, 20, 50, 100)),
  diamonds integer not null check (diamonds = package_usd * 100),
  amount_usdt numeric(18, 8) not null check (amount_usdt = package_usd + 1),
  bonus_vouchers integer not null default 100 check (bonus_vouchers = 100),
  receiver_uid text not null check (receiver_uid ~ '^[0-9]{5,20}$'),
  receiver_name text not null check (char_length(btrim(receiver_name)) between 2 and 120),
  receiver_qr_sha256 text not null check (receiver_qr_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'waiting_payment'
    check (status in ('waiting_payment', 'pending_review', 'credited', 'expired', 'cancelled')),
  verified_transaction_id text unique
    references public.binance_usdt_alert_transactions(transaction_id),
  verified_at timestamptz,
  credited_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  updated_at timestamptz not null default now(),
  constraint binance_checkout_expiration_valid check (expires_at > created_at),
  constraint binance_checkout_credit_evidence check (
    status <> 'credited' or (
      verified_transaction_id is not null and verified_at is not null and credited_at is not null
    )
  )
);

-- ALTER DEFAULT changes future inserts ONLY; historical orders/claims are
-- deliberately untouched so that a late transfer is not silently cancelled.
alter table public.binance_checkout_orders
  alter column expires_at set default (now() + interval '15 minutes');

create unique index if not exists binance_checkout_verified_tx_normalized_uq
  on public.binance_checkout_orders (upper(btrim(verified_transaction_id)))
  where verified_transaction_id is not null;

create unique index if not exists binance_checkout_one_active_per_reader_idx
  on public.binance_checkout_orders(user_id)
  where status in ('waiting_payment', 'pending_review');

create index if not exists binance_checkout_reader_history_idx
  on public.binance_checkout_orders(user_id, created_at desc, id desc);

create index if not exists binance_checkout_review_queue_idx
  on public.binance_checkout_orders(created_at, id)
  where status = 'pending_review';

-- Protect immutable order-time values, completed credits and official proof.
-- The approved Diamond credit action is inserted first by the existing RPC;
-- its Step-1 global claim trigger runs in that SAME SQL transaction.
create or replace function public.guard_binance_diamond_order_v2()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_receipt public.binance_usdt_alert_transactions%rowtype;
  v_profile_uid text;
  v_profile_updated timestamptz;
  v_profiles integer;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'waiting_payment' or new.verified_transaction_id is not null
       or new.verified_at is not null or new.credited_at is not null then
      raise exception 'BINANCE_DIAMOND_NEW_ORDER_MUST_WAIT';
    end if;
  else
    if new.id is distinct from old.id or new.user_id is distinct from old.user_id
       or new.package_usd is distinct from old.package_usd
       or new.diamonds is distinct from old.diamonds
       or new.amount_usdt is distinct from old.amount_usdt
       or new.bonus_vouchers is distinct from old.bonus_vouchers
       or new.receiver_uid is distinct from old.receiver_uid
       or new.receiver_name is distinct from old.receiver_name
       or new.receiver_qr_sha256 is distinct from old.receiver_qr_sha256
       or new.created_at is distinct from old.created_at
       or new.expires_at is distinct from old.expires_at then
      raise exception 'BINANCE_DIAMOND_ORDER_SNAPSHOT_IMMUTABLE';
    end if;
    if old.status in ('credited', 'expired', 'cancelled') and (
       new.status is distinct from old.status
       or new.verified_transaction_id is distinct from old.verified_transaction_id
       or new.verified_at is distinct from old.verified_at
       or new.credited_at is distinct from old.credited_at) then
      raise exception 'BINANCE_DIAMOND_TERMINAL_ORDER_IMMUTABLE';
    end if;
    if old.status = 'pending_review' and new.status not in ('pending_review','credited','cancelled') then
      raise exception 'BINANCE_DIAMOND_REVIEW_CANNOT_REOPEN';
    end if;
  end if;

  -- Existing credited records are not re-provisioned or revalidated by a
  -- harmless update of updated_at (historical receipt data may be incomplete).
  if new.status <> 'credited' then
    if new.verified_transaction_id is not null or new.verified_at is not null
       or new.credited_at is not null then
      raise exception 'BINANCE_DIAMOND_UNCREDITED_HAS_EVIDENCE';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'credited' then return new; end if;

  if new.verified_transaction_id is null or new.verified_at is null
     or new.credited_at is null then
    raise exception 'BINANCE_DIAMOND_CREDIT_EVIDENCE_REQUIRED';
  end if;

  -- An already-consumed official receipt + matching immutable credit ledger
  -- is mandatory. A client claim or status flag alone cannot mint Diamonds.
  if not exists (
    select 1 from public.shadow_binance_payment_claims c
    join public.admin_binance_usdt_credit_actions a
      on a.id = c.legacy_credit_action_id
    where c.provider='binance'
      and upper(btrim(c.transaction_id))=upper(btrim(new.verified_transaction_id))
      and c.user_id=new.user_id and c.purchase_kind='diamonds'
      and a.user_id=new.user_id and a.action_type='recovery'
      and upper(btrim(a.transaction_id))=upper(btrim(new.verified_transaction_id))
      and a.diamonds=new.diamonds
      and a.bonus_vouchers=new.bonus_vouchers
      and a.amount_usdt=new.amount_usdt
  ) then
    raise exception 'BINANCE_DIAMOND_GLOBAL_CREDIT_EVIDENCE_REQUIRED';
  end if;

  select * into v_receipt from public.binance_usdt_alert_transactions
    where transaction_id = new.verified_transaction_id;
  if not found or v_receipt.currency <> 'USDT'
     or v_receipt.order_type not in ('PAY','C2C')
     or v_receipt.amount is distinct from new.amount_usdt
     or v_receipt.receiver_uid is distinct from new.receiver_uid then
    raise exception 'BINANCE_DIAMOND_OFFICIAL_RECEIPT_MISMATCH';
  end if;

  select p.binance_uid,p.updated_at into v_profile_uid,v_profile_updated
    from public.reader_binance_payment_profiles p where p.user_id=new.user_id;
  select count(*) into v_profiles from public.reader_binance_payment_profiles p
    where p.binance_uid=v_profile_uid and v_profile_uid <> '';
  if nullif(v_profile_uid,'') is null or v_profiles <> 1
     or v_profile_updated > new.created_at
     or v_receipt.payer_uid is distinct from v_profile_uid then
    raise exception 'BINANCE_DIAMOND_VERIFIED_PAYER_UID_REQUIRED';
  end if;
  if v_receipt.transaction_time_ms <
       (extract(epoch from new.created_at)*1000-60000)::bigint
     or v_receipt.transaction_time_ms >
       (extract(epoch from new.expires_at)*1000+600000)::bigint then
    raise exception 'BINANCE_DIAMOND_RECEIPT_TIME_MISMATCH';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_binance_diamond_order_v2() from public,anon,authenticated;
drop trigger if exists binance_diamond_order_guard_v2 on public.binance_checkout_orders;
create trigger binance_diamond_order_guard_v2
  before insert or update on public.binance_checkout_orders
  for each row execute function public.guard_binance_diamond_order_v2();

alter table public.binance_checkout_orders enable row level security;

revoke all on public.binance_checkout_orders from public, anon, authenticated;
grant select, insert, update on public.binance_checkout_orders to service_role;

commit;
