create table if not exists public.author_store_custom_delivery_companies (
  author_page_id uuid primary key references public.author_pages (id) on delete cascade,
  user_id uuid not null,
  company_name text not null,
  fee_usd numeric(10, 2) not null default 0,
  logo_url text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint author_store_custom_delivery_name_check check (
    char_length(btrim(company_name)) between 1 and 80
    and company_name = btrim(company_name)
  ),
  constraint author_store_custom_delivery_fee_check check (
    fee_usd between 0 and 9999.99
  ),
  constraint author_store_custom_delivery_logo_check check (
    char_length(logo_url) between 20 and 1024
    and logo_url ~ '^https://'
  )
);

create index if not exists author_store_custom_delivery_user_idx
  on public.author_store_custom_delivery_companies (user_id);

alter table public.author_store_custom_delivery_companies enable row level security;

revoke all on table public.author_store_custom_delivery_companies from public, anon, authenticated;
grant select, insert, update, delete on table public.author_store_custom_delivery_companies to service_role;
