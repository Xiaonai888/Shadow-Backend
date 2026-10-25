begin;

create table if not exists public.author_store_book_shipping_proof_uploads (
  id uuid primary key default gen_random_uuid(),
  hold_id uuid not null references public.author_store_book_payment_holds(id) on delete restrict,
  author_page_id uuid not null references public.author_pages(id) on delete restrict,
  uploader_user_id uuid not null,
  storage_key text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint not null check (size_bytes between 16 and 5242880),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_author_store_book_shipping_proofs_hold
  on public.author_store_book_shipping_proof_uploads (hold_id, created_at desc);

alter table public.author_store_book_shipping_proof_uploads enable row level security;
revoke all on public.author_store_book_shipping_proof_uploads from public, anon, authenticated;
grant select, insert, update, delete on public.author_store_book_shipping_proof_uploads to service_role;

commit;
