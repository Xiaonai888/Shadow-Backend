begin;

create table if not exists public.binance_checkout_claims (
  order_id uuid primary key references public.binance_checkout_orders(id) on delete restrict,
  user_id uuid not null references public.users(id) on delete restrict,
  transaction_id text not null unique check (transaction_id ~ '^[A-Za-z0-9_-]{6,128}$'),
  review_status text not null default 'submitted'
    check (review_status in ('submitted', 'approved', 'rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint binance_checkout_claim_review_consistency check (
    (review_status = 'submitted' and reviewed_at is null)
    or (review_status in ('approved', 'rejected') and reviewed_at is not null)
  )
);

create index if not exists binance_checkout_claims_reader_idx
  on public.binance_checkout_claims(user_id, submitted_at desc);
create index if not exists binance_checkout_claims_review_idx
  on public.binance_checkout_claims(submitted_at, order_id)
  where review_status = 'submitted';

alter table public.binance_checkout_claims enable row level security;
revoke all on public.binance_checkout_claims from public, anon, authenticated;
grant select, insert, update on public.binance_checkout_claims to service_role;

create or replace function public.submit_binance_checkout_claim_v1(
  p_user_id uuid,
  p_order_id uuid,
  p_transaction_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.binance_checkout_orders%rowtype;
  v_claim public.binance_checkout_claims%rowtype;
  v_transaction text := btrim(coalesce(p_transaction_id, ''));
begin
  if p_user_id is null or p_order_id is null
    or v_transaction !~ '^[A-Za-z0-9_-]{6,128}$' then
    raise exception 'INVALID_BINANCE_CLAIM';
  end if;

  select * into v_order
  from public.binance_checkout_orders
  where id = p_order_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'BINANCE_CHECKOUT_NOT_FOUND';
  end if;

  select * into v_claim
  from public.binance_checkout_claims
  where order_id = p_order_id
  for update;

  if found then
    if v_claim.transaction_id <> v_transaction then
      raise exception 'BINANCE_ORDER_ALREADY_CLAIMED';
    end if;
    return jsonb_build_object(
      'ok', true,
      'order_id', p_order_id,
      'review_status', v_claim.review_status,
      'submitted_at', v_claim.submitted_at
    );
  end if;

  if v_order.status not in ('waiting_payment', 'pending_review') then
    raise exception 'BINANCE_ORDER_NOT_CLAIMABLE';
  end if;

  if clock_timestamp() > v_order.created_at + interval '24 hours' then
    raise exception 'BINANCE_CLAIM_WINDOW_CLOSED';
  end if;

  if exists (
    select 1 from public.binance_checkout_claims
    where transaction_id = v_transaction
  ) then
    raise exception 'BINANCE_TRANSACTION_ALREADY_CLAIMED';
  end if;

  insert into public.binance_checkout_claims(order_id, user_id, transaction_id)
  values (p_order_id, p_user_id, v_transaction)
  returning * into v_claim;

  update public.binance_checkout_orders
  set status = 'pending_review', updated_at = now()
  where id = p_order_id and user_id = p_user_id
    and status = 'waiting_payment';

  return jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'review_status', 'submitted',
    'submitted_at', v_claim.submitted_at
  );
end;
$$;

revoke all on function public.submit_binance_checkout_claim_v1(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.submit_binance_checkout_claim_v1(uuid,uuid,text)
  to service_role;

commit;
