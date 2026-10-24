begin;

create table if not exists public.binance_usdt_alert_cursor (
  source text primary key default 'personal_pay' check (source = 'personal_pay'),
  cursor_ms bigint not null check (cursor_ms > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.binance_usdt_alert_transactions (
  transaction_id text primary key check (transaction_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  transaction_time_ms bigint not null check (transaction_time_ms > 0),
  amount numeric(28, 8) not null check (amount > 0),
  currency text not null default 'USDT' check (currency = 'USDT'),
  order_type text not null default '' check (char_length(order_type) <= 40),
  payer_name text not null default '' check (char_length(payer_name) <= 120),
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  telegram_message_id bigint,
  telegram_sent_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists binance_usdt_alert_transactions_due_idx
  on public.binance_usdt_alert_transactions
  (next_attempt_at, transaction_time_ms, transaction_id)
  where delivery_status in ('pending', 'failed', 'sending');

alter table public.binance_usdt_alert_cursor enable row level security;
alter table public.binance_usdt_alert_transactions enable row level security;

revoke all on public.binance_usdt_alert_cursor from public, anon, authenticated;
revoke all on public.binance_usdt_alert_transactions from public, anon, authenticated;

grant select, insert, update on public.binance_usdt_alert_cursor to service_role;
grant select, insert, update on public.binance_usdt_alert_transactions to service_role;

insert into public.binance_usdt_alert_cursor (source, cursor_ms)
values ('personal_pay', floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
on conflict (source) do nothing;

create or replace function public.claim_binance_usdt_alerts(p_limit integer default 10)
returns setof public.binance_usdt_alert_transactions
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select transaction_id
    from public.binance_usdt_alert_transactions
    where attempt_count < 20
      and (
        (delivery_status in ('pending', 'failed') and next_attempt_at <= now())
        or (
          delivery_status = 'sending'
          and coalesce(claimed_at, created_at) <= now() - interval '10 minutes'
        )
      )
    order by transaction_time_ms, transaction_id
    limit greatest(1, least(coalesce(p_limit, 10), 20))
    for update skip locked
  )
  update public.binance_usdt_alert_transactions as alert
  set delivery_status = 'sending',
      attempt_count = alert.attempt_count + 1,
      claimed_at = now(),
      updated_at = now()
  from candidates
  where alert.transaction_id = candidates.transaction_id
  returning alert.*;
$$;

revoke all on function public.claim_binance_usdt_alerts(integer)
  from public, anon, authenticated;
grant execute on function public.claim_binance_usdt_alerts(integer)
  to service_role;

commit;
