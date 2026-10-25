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
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  updated_at timestamptz not null default now(),
  constraint binance_checkout_expiration_valid check (expires_at > created_at),
  constraint binance_checkout_credit_evidence check (
    status <> 'credited' or (
      verified_transaction_id is not null and verified_at is not null and credited_at is not null
    )
  )
);

create unique index if not exists binance_checkout_one_active_per_reader_idx
  on public.binance_checkout_orders(user_id)
  where status in ('waiting_payment', 'pending_review');

create index if not exists binance_checkout_reader_history_idx
  on public.binance_checkout_orders(user_id, created_at desc, id desc);

create index if not exists binance_checkout_review_queue_idx
  on public.binance_checkout_orders(created_at, id)
  where status = 'pending_review';

alter table public.binance_checkout_orders enable row level security;

revoke all on public.binance_checkout_orders from public, anon, authenticated;
grant select, insert, update on public.binance_checkout_orders to service_role;

commit;
