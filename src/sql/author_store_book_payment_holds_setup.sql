create extension if not exists pgcrypto;

create table if not exists public.author_store_book_payment_holds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.author_store_orders(id) on delete restrict,
  author_page_id uuid not null references public.author_pages(id) on delete restrict,
  buyer_id uuid,
  held_amount_cents bigint not null check (held_amount_cents > 0),
  status text not null default 'awaiting_reader'
    check (status in ('awaiting_reader', 'under_review', 'released', 'refunded')),
  delivery_company text not null default '',
  tracking_number text not null default '',
  proof_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(proof_refs) = 'array'),
  reader_confirmed_at timestamptz,
  review_requested_at timestamptz,
  released_at timestamptz,
  release_source text
    check (release_source in ('reader', 'admin')),
  admin_actor_id text,
  admin_review_reason text not null default '',
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint book_hold_release_consistency check (
    (status = 'released' and released_at is not null and release_source is not null)
    or (status <> 'released' and released_at is null and release_source is null)
  ),
  constraint book_hold_refund_consistency check (
    (status = 'refunded' and refunded_at is not null)
    or (status <> 'refunded' and refunded_at is null)
  )
);

create index if not exists idx_author_store_book_holds_author_status
  on public.author_store_book_payment_holds (author_page_id, status, created_at desc);

create index if not exists idx_author_store_book_holds_buyer_status
  on public.author_store_book_payment_holds (buyer_id, status, created_at desc);

create table if not exists public.author_store_book_payment_hold_events (
  id uuid primary key default gen_random_uuid(),
  hold_id uuid not null references public.author_store_book_payment_holds(id) on delete restrict,
  action text not null
    check (action in ('created', 'shipment_updated', 'review_requested', 'reader_confirmed', 'admin_approved', 'released', 'refunded')),
  actor_type text not null
    check (actor_type in ('system', 'reader', 'author', 'admin')),
  actor_id text,
  reason text not null default '',
  evidence_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence_refs) = 'array'),
  created_at timestamptz not null default now()
);

create index if not exists idx_author_store_book_hold_events_hold_time
  on public.author_store_book_payment_hold_events (hold_id, created_at desc);

alter table public.author_store_book_payment_holds enable row level security;
alter table public.author_store_book_payment_hold_events enable row level security;

revoke all on table public.author_store_book_payment_holds from public, anon, authenticated;
revoke all on table public.author_store_book_payment_hold_events from public, anon, authenticated;

grant select, insert, update on table public.author_store_book_payment_holds to service_role;
grant select, insert on table public.author_store_book_payment_hold_events to service_role;
