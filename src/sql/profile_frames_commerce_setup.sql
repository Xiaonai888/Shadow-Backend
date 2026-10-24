begin;

alter table public.profile_frames
  drop constraint if exists profile_frames_access_tier_check;

alter table public.profile_frames
  add constraint profile_frames_access_tier_check
  check (access_tier in ('free', 'premium', 'coins', 'diamonds'));

alter table public.profile_frames
  add column if not exists coin_price integer not null default 0,
  add column if not exists diamond_price integer not null default 0;

alter table public.profile_frames
  drop constraint if exists profile_frames_price_check;

alter table public.profile_frames
  add constraint profile_frames_price_check check (
    (access_tier = 'coins' and coin_price > 0 and diamond_price = 0)
    or (access_tier = 'diamonds' and diamond_price > 0 and coin_price = 0)
    or (access_tier in ('free', 'premium') and coin_price = 0 and diamond_price = 0)
  );

create table if not exists public.reader_profile_frame_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  frame_id uuid not null references public.profile_frames(id) on delete restrict,
  currency text not null check (currency in ('coins', 'diamonds')),
  amount integer not null check (amount > 0),
  idempotency_key uuid not null,
  purchased_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (user_id, idempotency_key),
  check (
    (currency = 'coins' and expires_at is not null and expires_at > purchased_at)
    or (currency = 'diamonds' and expires_at is null)
  )
);

create index if not exists reader_profile_frame_purchases_entitlement_idx
  on public.reader_profile_frame_purchases (user_id, frame_id, purchased_at desc);

create index if not exists reader_profile_frame_purchases_expiry_idx
  on public.reader_profile_frame_purchases (user_id, expires_at);

alter table public.reader_profile_frame_purchases enable row level security;
revoke all on public.reader_profile_frame_purchases from public, anon, authenticated;
grant select, insert, update, delete on public.reader_profile_frame_purchases to service_role;

commit;
