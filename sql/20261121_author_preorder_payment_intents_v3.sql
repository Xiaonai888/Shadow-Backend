create table if not exists public.author_preorder_payment_intents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.author_preorder_orders(id) on delete restrict,
  merchant_transaction_id text not null unique,
  expected_amount_usd numeric(12,2) not null,
  currency text not null default 'USD',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  constraint author_preorder_intent_ref_chk check (
    merchant_transaction_id ~ '^P[A-Z0-9]{12,39}$'
  ),
  constraint author_preorder_intent_amount_chk check (expected_amount_usd > 0),
  constraint author_preorder_intent_currency_chk check (currency = 'USD'),
  constraint author_preorder_intent_expiry_chk check (expires_at > created_at),
  constraint author_preorder_intent_finalized_chk check (
    finalized_at is null or finalized_at >= created_at
  )
);

create index if not exists author_preorder_payment_intents_created_idx
  on public.author_preorder_payment_intents (created_at desc);

alter table public.author_preorder_payment_intents enable row level security;

revoke all on table public.author_preorder_payment_intents from public, anon, authenticated;

grant select, insert, update on table public.author_preorder_payment_intents to service_role;

create or replace function public.author_preorder_payment_intent_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_order public.author_preorder_orders%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'PRE_ORDER_PAYMENT_INTENT_IMMUTABLE';
  end if;

  if tg_op = 'INSERT' then
    select o.* into v_order
    from public.author_preorder_orders o
    where o.id = new.order_id
    for share;

    if not found or v_order.payment_status <> 'pending'
       or v_order.fulfillment_status <> 'awaiting_payment'
       or v_order.paid_at is not null
       or v_order.total_usd <> new.expected_amount_usd then
      raise exception 'PRE_ORDER_PAYMENT_INTENT_ORDER_INVALID';
    end if;
    if new.finalized_at is not null then
      raise exception 'PRE_ORDER_PAYMENT_INTENT_ALREADY_FINALIZED';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.order_id is distinct from old.order_id
     or new.merchant_transaction_id is distinct from old.merchant_transaction_id
     or new.expected_amount_usd is distinct from old.expected_amount_usd
     or new.currency is distinct from old.currency
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at
     or old.finalized_at is not null and new.finalized_at is distinct from old.finalized_at
     or old.finalized_at is null and new.finalized_at is null then
    raise exception 'PRE_ORDER_PAYMENT_INTENT_IMMUTABLE';
  end if;

  select o.* into v_order
  from public.author_preorder_orders o
  where o.id = old.order_id;
  if not found or v_order.payment_status <> 'paid'
     or v_order.payment_reference is distinct from old.merchant_transaction_id
     or v_order.paid_at is null
     or not exists (
       select 1 from public.author_preorder_fee_ledger l
       where l.order_id = old.order_id and l.author_page_id = v_order.author_page_id
     ) then
    raise exception 'PRE_ORDER_PAYMENT_INTENT_UNVERIFIED';
  end if;
  return new;
end;
$$;

drop trigger if exists author_preorder_payment_intent_guard_trg
  on public.author_preorder_payment_intents;

create trigger author_preorder_payment_intent_guard_trg
before insert or update or delete on public.author_preorder_payment_intents
for each row execute function public.author_preorder_payment_intent_guard();

revoke all on function public.author_preorder_payment_intent_guard() from public, anon, authenticated;
