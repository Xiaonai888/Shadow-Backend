begin;

create table if not exists public.author_binance_payout_methods (
  author_id uuid primary key references public.author_pages(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  account_name text not null check (char_length(btrim(account_name)) between 2 and 160),
  bank_name text generated always as ('Binance Auto'::text) stored,
  binance_uid text check (binance_uid is null or binance_uid ~ '^[A-Za-z0-9_-]{4,64}$'),
  binance_pay_id text check (binance_pay_id is null or binance_pay_id ~ '^[A-Za-z0-9_-]{4,64}$'),
  qr_image_url text not null check (char_length(qr_image_url) between 12 and 2048 and qr_image_url ~ '^https://'),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint author_binance_identifier_required check (
    nullif(btrim(coalesce(binance_uid, '')), '') is not null
    or nullif(btrim(coalesce(binance_pay_id, '')), '') is not null
  )
);

create index if not exists author_binance_payout_owner_idx
  on public.author_binance_payout_methods (user_id);

create table if not exists public.reader_binance_account_bindings (
  user_id uuid primary key references public.users(id) on delete cascade,
  binance_uid text check (binance_uid is null or binance_uid ~ '^[A-Za-z0-9_-]{4,64}$'),
  binance_pay_id text check (binance_pay_id is null or binance_pay_id ~ '^[A-Za-z0-9_-]{4,64}$'),
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected')),
  verification_source text check (
    verification_source is null or verification_source in ('binance_api', 'admin_verified')
  ),
  verification_reference text check (
    verification_reference is null or char_length(verification_reference) between 1 and 200
  ),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reader_binance_identifier_required check (
    nullif(btrim(coalesce(binance_uid, '')), '') is not null
    or nullif(btrim(coalesce(binance_pay_id, '')), '') is not null
  ),
  constraint reader_binance_verified_evidence_required check (
    verification_status <> 'verified'
    or (verified_at is not null and verification_source is not null and verification_reference is not null)
  )
);

create unique index if not exists reader_binance_verified_uid_unique
  on public.reader_binance_account_bindings (upper(btrim(binance_uid)))
  where binance_uid is not null and verification_status = 'verified';

create unique index if not exists reader_binance_verified_pay_id_unique
  on public.reader_binance_account_bindings (upper(btrim(binance_pay_id)))
  where binance_pay_id is not null and verification_status = 'verified';

create index if not exists reader_binance_verification_queue_idx
  on public.reader_binance_account_bindings (created_at)
  where verification_status = 'pending';

alter table public.author_binance_payout_methods enable row level security;
alter table public.reader_binance_account_bindings enable row level security;

revoke all on public.author_binance_payout_methods from public, anon, authenticated;
revoke all on public.reader_binance_account_bindings from public, anon, authenticated;

grant select, insert, update, delete on public.author_binance_payout_methods to service_role;
grant select, insert, update, delete on public.reader_binance_account_bindings to service_role;

commit;
