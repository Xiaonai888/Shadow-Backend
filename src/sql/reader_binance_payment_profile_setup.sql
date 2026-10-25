begin;

create table if not exists public.reader_binance_payment_profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  binance_account_name text not null default ''
    check (char_length(binance_account_name) <= 80),
  binance_uid text not null default ''
    check (binance_uid = '' or binance_uid ~ '^[0-9]{5,20}$'),
  updated_at timestamptz not null default now(),
  constraint reader_binance_payment_profile_pair_check check (
    (binance_account_name = '' and binance_uid = '')
    or (char_length(btrim(binance_account_name)) between 2 and 80 and binance_uid ~ '^[0-9]{5,20}$')
  )
);

alter table public.reader_binance_payment_profiles enable row level security;

revoke all on public.reader_binance_payment_profiles from public, anon, authenticated;
grant select, insert, update on public.reader_binance_payment_profiles to service_role;

commit;
