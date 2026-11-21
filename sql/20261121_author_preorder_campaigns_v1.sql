create extension if not exists pgcrypto;

create table if not exists public.author_preorder_campaigns (
  id uuid primary key default gen_random_uuid(),
  author_page_id uuid not null references public.author_pages(id) on delete cascade,
  owner_user_id uuid not null,
  title text not null default '',
  description text not null default '',
  genre text not null default '',
  author_note text not null default '',
  banner_url text not null default '',
  open_at timestamptz,
  close_at timestamptz,
  expected_ship_at timestamptz,
  signature_enabled boolean not null default false,
  signature_fee_usd numeric(10,2) not null default 0,
  signature_note text not null default '',
  delivery_company_keys jsonb not null default '[]'::jsonb,
  delivery_note text not null default '',
  buyer_note_instruction text not null default '',
  status text not null default 'draft',
  total_orders integer not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint author_preorder_campaign_status_chk check (status in ('draft','scheduled','active','closed','completed','cancelled')),
  constraint author_preorder_campaign_title_len_chk check (char_length(title) <= 160),
  constraint author_preorder_campaign_description_len_chk check (char_length(description) <= 500),
  constraint author_preorder_campaign_dates_chk check (
    (open_at is null or close_at is null or close_at > open_at)
    and (close_at is null or expected_ship_at is null or expected_ship_at >= close_at)
  ),
  constraint author_preorder_campaign_signature_fee_chk check (signature_fee_usd between 0 and 9999.99),
  constraint author_preorder_campaign_order_count_chk check (total_orders >= 0),
  constraint author_preorder_campaign_delivery_keys_chk check (jsonb_typeof(delivery_company_keys) = 'array')
);

create index if not exists author_preorder_campaign_owner_idx
  on public.author_preorder_campaigns (author_page_id, created_at desc);

create index if not exists author_preorder_campaign_status_idx
  on public.author_preorder_campaigns (author_page_id, status, created_at desc);

create table if not exists public.author_preorder_books (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.author_preorder_campaigns(id) on delete cascade,
  position integer not null,
  title text not null default '',
  cover_url text not null default '',
  standard_enabled boolean not null default true,
  standard_price_usd numeric(10,2) not null default 0,
  standard_quota integer not null default 0,
  standard_reserved integer not null default 0,
  limited_enabled boolean not null default false,
  limited_price_usd numeric(10,2) not null default 0,
  limited_quota integer not null default 0,
  limited_reserved integer not null default 0,
  created_at timestamptz not null default now(),
  unique (campaign_id, position),
  constraint author_preorder_book_position_chk check (position between 0 and 9),
  constraint author_preorder_book_title_chk check (char_length(title) <= 180),
  constraint author_preorder_book_price_chk check (
    standard_price_usd between 0 and 9999.99 and limited_price_usd between 0 and 9999.99
  ),
  constraint author_preorder_book_quota_chk check (
    standard_quota between 0 and 1000000 and limited_quota between 0 and 1000000
    and standard_reserved between 0 and standard_quota
    and limited_reserved between 0 and limited_quota
  )
);

create index if not exists author_preorder_books_campaign_idx
  on public.author_preorder_books (campaign_id, position);

create table if not exists public.author_preorder_orders (
  id uuid primary key default gen_random_uuid(),
  author_page_id uuid not null references public.author_pages(id),
  campaign_id uuid not null references public.author_preorder_campaigns(id),
  buyer_user_id uuid not null,
  payment_status text not null default 'pending',
  fulfillment_status text not null default 'awaiting_payment',
  subtotal_usd numeric(12,2) not null default 0,
  signature_fee_usd numeric(12,2) not null default 0,
  delivery_fee_usd numeric(12,2) not null default 0,
  total_usd numeric(12,2) not null default 0,
  buyer_snapshot jsonb not null default '{}'::jsonb,
  delivery_snapshot jsonb not null default '{}'::jsonb,
  signature_requested boolean not null default false,
  signature_name text not null default '',
  buyer_note text not null default '',
  payment_reference text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint author_preorder_order_payment_status_chk check (payment_status in ('pending','paid','failed','expired','refunded')),
  constraint author_preorder_order_fulfillment_status_chk check (fulfillment_status in ('awaiting_payment','reserved','production','shipping','completed','cancelled','delayed')),
  constraint author_preorder_order_amounts_chk check (
    subtotal_usd >= 0 and signature_fee_usd >= 0 and delivery_fee_usd >= 0 and total_usd >= 0
  )
);

create unique index if not exists author_preorder_orders_payment_reference_idx
  on public.author_preorder_orders (payment_reference)
  where payment_reference is not null;

create index if not exists author_preorder_orders_author_idx
  on public.author_preorder_orders (author_page_id, created_at desc);

create index if not exists author_preorder_orders_buyer_idx
  on public.author_preorder_orders (buyer_user_id, created_at desc);

create table if not exists public.author_preorder_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.author_preorder_orders(id) on delete cascade,
  book_id uuid not null references public.author_preorder_books(id),
  edition text not null,
  quantity integer not null,
  unit_price_usd numeric(10,2) not null,
  book_title_snapshot text not null,
  created_at timestamptz not null default now(),
  constraint author_preorder_order_item_edition_chk check (edition in ('standard','limited')),
  constraint author_preorder_order_item_quantity_chk check (quantity between 1 and 99),
  constraint author_preorder_order_item_price_chk check (unit_price_usd between 0 and 9999.99)
);

create index if not exists author_preorder_order_items_order_idx
  on public.author_preorder_order_items (order_id);

create table if not exists public.author_preorder_fee_ledger (
  id uuid primary key default gen_random_uuid(),
  author_page_id uuid not null references public.author_pages(id),
  order_id uuid not null unique references public.author_preorder_orders(id),
  successful_order_number bigint not null,
  service_fee_usd numeric(12,3) not null default 0,
  created_at timestamptz not null default now(),
  unique (author_page_id, successful_order_number),
  constraint author_preorder_fee_number_chk check (successful_order_number > 0),
  constraint author_preorder_fee_amount_chk check (service_fee_usd in (0,0.125))
);

create index if not exists author_preorder_fee_ledger_author_idx
  on public.author_preorder_fee_ledger (author_page_id, created_at desc);

alter table public.author_preorder_campaigns enable row level security;
alter table public.author_preorder_books enable row level security;
alter table public.author_preorder_orders enable row level security;
alter table public.author_preorder_order_items enable row level security;
alter table public.author_preorder_fee_ledger enable row level security;

revoke all on table public.author_preorder_campaigns, public.author_preorder_books,
  public.author_preorder_orders, public.author_preorder_order_items,
  public.author_preorder_fee_ledger from public, anon, authenticated;

grant select, insert, update, delete on table public.author_preorder_campaigns,
  public.author_preorder_books, public.author_preorder_orders,
  public.author_preorder_order_items, public.author_preorder_fee_ledger to service_role;

create or replace function public.author_preorder_save_draft(
  p_author_page_id uuid,
  p_owner_user_id uuid,
  p_campaign_id uuid,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_book jsonb;
  v_standard jsonb;
  v_limited jsonb;
  v_position integer := 0;
  v_status text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or jsonb_typeof(p_payload->'books') <> 'array'
     or jsonb_array_length(p_payload->'books') not between 1 and 10 then
    raise exception 'PRE_ORDER_INVALID_PAYLOAD';
  end if;

  if not exists (
    select 1 from public.author_pages
    where id = p_author_page_id and user_id = p_owner_user_id and status = 'active'
  ) then
    raise exception 'PRE_ORDER_NOT_OWNER';
  end if;

  if p_campaign_id is null then
    insert into public.author_preorder_campaigns (
      author_page_id, owner_user_id, title, description, genre, author_note,
      banner_url, open_at, close_at, expected_ship_at, signature_enabled,
      signature_fee_usd, signature_note, delivery_company_keys, delivery_note,
      buyer_note_instruction, status
    ) values (
      p_author_page_id, p_owner_user_id, p_payload->>'title', p_payload->>'description',
      p_payload->>'genre', p_payload->>'author_note', p_payload->>'banner_url',
      nullif(p_payload->>'open_at','')::timestamptz,
      nullif(p_payload->>'close_at','')::timestamptz,
      nullif(p_payload->>'expected_ship_at','')::timestamptz,
      coalesce((p_payload->>'signature_enabled')::boolean,false),
      coalesce((p_payload->>'signature_fee_usd')::numeric,0),
      coalesce(p_payload->>'signature_note',''),
      coalesce(p_payload->'delivery_company_keys','[]'::jsonb),
      coalesce(p_payload->>'delivery_note',''),
      coalesce(p_payload->>'buyer_note_instruction',''), 'draft'
    ) returning id into v_campaign_id;
  else
    select status into v_status
    from public.author_preorder_campaigns
    where id = p_campaign_id and author_page_id = p_author_page_id
      and owner_user_id = p_owner_user_id
    for update;

    if v_status is null then
      raise exception 'PRE_ORDER_NOT_FOUND';
    end if;
    if v_status <> 'draft' then
      raise exception 'PRE_ORDER_NOT_EDITABLE';
    end if;

    update public.author_preorder_campaigns set
      title = p_payload->>'title',
      description = p_payload->>'description',
      genre = p_payload->>'genre',
      author_note = p_payload->>'author_note',
      banner_url = p_payload->>'banner_url',
      open_at = nullif(p_payload->>'open_at','')::timestamptz,
      close_at = nullif(p_payload->>'close_at','')::timestamptz,
      expected_ship_at = nullif(p_payload->>'expected_ship_at','')::timestamptz,
      signature_enabled = coalesce((p_payload->>'signature_enabled')::boolean,false),
      signature_fee_usd = coalesce((p_payload->>'signature_fee_usd')::numeric,0),
      signature_note = coalesce(p_payload->>'signature_note',''),
      delivery_company_keys = coalesce(p_payload->'delivery_company_keys','[]'::jsonb),
      delivery_note = coalesce(p_payload->>'delivery_note',''),
      buyer_note_instruction = coalesce(p_payload->>'buyer_note_instruction',''),
      updated_at = now()
    where id = p_campaign_id;

    v_campaign_id := p_campaign_id;
    delete from public.author_preorder_books where campaign_id = v_campaign_id;
  end if;

  for v_book in select value from jsonb_array_elements(p_payload->'books') loop
    v_standard := coalesce(v_book->'editions'->'standard','{}'::jsonb);
    v_limited := coalesce(v_book->'editions'->'limited','{}'::jsonb);
    insert into public.author_preorder_books (
      campaign_id, position, title, cover_url,
      standard_enabled, standard_price_usd, standard_quota,
      limited_enabled, limited_price_usd, limited_quota
    ) values (
      v_campaign_id, v_position, coalesce(v_book->>'title',''),
      coalesce(v_book->>'cover_url',''),
      coalesce((v_standard->>'enabled')::boolean,false),
      coalesce((v_standard->>'price_usd')::numeric,0),
      coalesce((v_standard->>'quota')::integer,0),
      coalesce((v_limited->>'enabled')::boolean,false),
      coalesce((v_limited->>'price_usd')::numeric,0),
      coalesce((v_limited->>'quota')::integer,0)
    );
    v_position := v_position + 1;
  end loop;

  return v_campaign_id;
end;
$$;

revoke all on function public.author_preorder_save_draft(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.author_preorder_save_draft(uuid,uuid,uuid,jsonb) to service_role;

create or replace function public.author_preorder_summary(
  p_author_page_id uuid,
  p_owner_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'all', count(*),
    'draft', count(*) filter (where status = 'draft'),
    'scheduled', count(*) filter (where status = 'scheduled'),
    'active', count(*) filter (where status = 'active'),
    'closed', count(*) filter (where status = 'closed'),
    'completed', count(*) filter (where status = 'completed'),
    'cancelled', count(*) filter (where status = 'cancelled')
  )
  from public.author_preorder_campaigns
  where author_page_id = p_author_page_id and owner_user_id = p_owner_user_id;
$$;

revoke all on function public.author_preorder_summary(uuid,uuid) from public, anon, authenticated;
grant execute on function public.author_preorder_summary(uuid,uuid) to service_role;
