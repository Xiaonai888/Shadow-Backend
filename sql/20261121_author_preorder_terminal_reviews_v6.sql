create table if not exists public.author_preorder_terminal_reviews (
  order_id uuid primary key references public.author_preorder_orders(id) on delete restrict,
  merchant_transaction_id text not null,
  first_checked_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  review_count integer not null default 1,
  last_observation text not null,
  released_at timestamptz,
  released_by uuid,
  terminal_status text,
  evidence_reference text,
  verified_at timestamptz,
  constraint author_preorder_terminal_review_count_chk check (review_count between 1 and 1000000),
  constraint author_preorder_terminal_review_observation_chk check (last_observation ~ '^PRE_ORDER_[A-Z0-9_]{3,80}$'),
  constraint author_preorder_terminal_review_release_chk check (
    (released_at is null and released_by is null and terminal_status is null and evidence_reference is null and verified_at is null)
    or (released_at is not null and released_by is not null and terminal_status in ('EXPIRED','CANCELLED')
      and evidence_reference is not null and verified_at is not null)
  )
);

create index if not exists author_preorder_terminal_reviews_pending_idx
  on public.author_preorder_terminal_reviews (last_checked_at)
  where released_at is null;

alter table public.author_preorder_terminal_reviews enable row level security;
revoke all on table public.author_preorder_terminal_reviews from public, anon, authenticated;
grant select, insert, update on table public.author_preorder_terminal_reviews to service_role;

create or replace function public.author_preorder_record_terminal_review(
  p_order_id uuid,
  p_transaction_id text,
  p_observation text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_intent public.author_preorder_payment_intents%rowtype;
  v_order public.author_preorder_orders%rowtype;
  v_review public.author_preorder_terminal_reviews%rowtype;
begin
  if p_order_id is null or p_transaction_id is null or p_observation is null
     or p_observation !~ '^PRE_ORDER_[A-Z0-9_]{3,80}$' then
    raise exception 'PRE_ORDER_TERMINAL_REVIEW_INPUT_INVALID';
  end if;
  select * into v_order from public.author_preorder_orders where id = p_order_id for update;
  if not found or v_order.payment_status <> 'pending' or v_order.paid_at is not null then
    raise exception 'PRE_ORDER_TERMINAL_REVIEW_ORDER_INVALID';
  end if;
  select * into v_intent from public.author_preorder_payment_intents where order_id = p_order_id;
  if not found or v_intent.merchant_transaction_id is distinct from p_transaction_id then
    raise exception 'PRE_ORDER_TERMINAL_REVIEW_INTENT_MISMATCH';
  end if;
  insert into public.author_preorder_terminal_reviews (
    order_id, merchant_transaction_id, last_observation
  ) values (
    p_order_id, p_transaction_id, p_observation
  ) on conflict (order_id) do update set
    last_checked_at = now(),
    review_count = least(1000000, public.author_preorder_terminal_reviews.review_count + 1),
    last_observation = excluded.last_observation
  where public.author_preorder_terminal_reviews.released_at is null
    and public.author_preorder_terminal_reviews.merchant_transaction_id = excluded.merchant_transaction_id;
  if not found then
    raise exception 'PRE_ORDER_TERMINAL_REVIEW_LOCKED';
  end if;
  select * into v_review from public.author_preorder_terminal_reviews where order_id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'review_count', v_review.review_count,
    'last_checked_at', v_review.last_checked_at);
end;
$$;

revoke all on function public.author_preorder_record_terminal_review(uuid,text,text) from public, anon, authenticated;
grant execute on function public.author_preorder_record_terminal_review(uuid,text,text) to service_role;

create or replace function public.author_preorder_release_verified_terminal_hold(
  p_order_id uuid,
  p_transaction_id text,
  p_staff_user_id uuid,
  p_provider_terminal_status text,
  p_evidence_reference text,
  p_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page_id uuid;
  v_order public.author_preorder_orders%rowtype;
  v_hold public.author_preorder_stock_holds%rowtype;
  v_intent public.author_preorder_payment_intents%rowtype;
  v_review public.author_preorder_terminal_reviews%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_order_id is null or p_staff_user_id is null
     or p_provider_terminal_status is null
     or p_provider_terminal_status not in ('EXPIRED','CANCELLED')
     or p_evidence_reference is null or p_evidence_reference !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,119}$'
     or p_verified_at is null or p_verified_at < v_now - interval '5 minutes'
     or p_verified_at > v_now + interval '30 seconds' then
    raise exception 'PRE_ORDER_TERMINAL_EVIDENCE_INVALID';
  end if;
  select author_page_id into v_page_id from public.author_preorder_orders where id = p_order_id;
  if v_page_id is null then raise exception 'PRE_ORDER_TERMINAL_ORDER_NOT_FOUND'; end if;
  perform 1 from public.author_pages where id = v_page_id for update;
  if not found then raise exception 'PRE_ORDER_TERMINAL_AUTHOR_NOT_FOUND'; end if;
  select * into v_order from public.author_preorder_orders
  where id = p_order_id and author_page_id = v_page_id for update;
  if not found then raise exception 'PRE_ORDER_TERMINAL_ORDER_NOT_FOUND'; end if;
  select * into v_hold from public.author_preorder_stock_holds where order_id = p_order_id for update;
  if not found then raise exception 'PRE_ORDER_TERMINAL_HOLD_NOT_FOUND'; end if;
  select * into v_intent from public.author_preorder_payment_intents where order_id = p_order_id;
  if not found or v_intent.merchant_transaction_id is distinct from p_transaction_id then
    raise exception 'PRE_ORDER_TERMINAL_INTENT_MISMATCH';
  end if;
  select * into v_review from public.author_preorder_terminal_reviews where order_id = p_order_id for update;
  if not found then raise exception 'PRE_ORDER_TERMINAL_REVIEW_REQUIRED'; end if;
  if v_hold.status = 'released' then
    if v_order.payment_status = 'expired' and v_review.released_at is not null
       and v_review.merchant_transaction_id = p_transaction_id then
      return jsonb_build_object('order_id', p_order_id, 'released', true, 'reused', true);
    end if;
    raise exception 'PRE_ORDER_TERMINAL_RELEASE_STATE_MISMATCH';
  end if;
  if v_hold.status <> 'held' or v_order.payment_status <> 'pending'
     or v_order.fulfillment_status <> 'awaiting_payment' or v_order.paid_at is not null
     or v_intent.finalized_at is not null or v_review.released_at is not null
     or v_review.merchant_transaction_id is distinct from p_transaction_id then
    raise exception 'PRE_ORDER_TERMINAL_RELEASE_NOT_ALLOWED';
  end if;
  if v_review.review_count < 2 or v_review.first_checked_at > v_now - interval '2 minutes'
     or v_review.last_checked_at < v_now - interval '5 minutes'
     or v_hold.expires_at > v_now - interval '30 minutes'
     or v_intent.expires_at > v_now - interval '30 minutes'
     or p_verified_at < greatest(v_hold.expires_at, v_intent.expires_at) then
    raise exception 'PRE_ORDER_TERMINAL_RELEASE_PREMATURE';
  end if;
  if exists (select 1 from public.author_preorder_fee_ledger where order_id = p_order_id)
     or v_order.payment_reference is not null then
    raise exception 'PRE_ORDER_TERMINAL_PAYMENT_REQUIRES_REVIEW';
  end if;
  update public.author_preorder_stock_holds
  set status = 'released', released_at = v_now
  where order_id = p_order_id and status = 'held';
  if not found then raise exception 'PRE_ORDER_TERMINAL_RELEASE_CONFLICT'; end if;
  update public.author_preorder_orders
  set payment_status = 'expired', fulfillment_status = 'cancelled', updated_at = now()
  where id = p_order_id and payment_status = 'pending';
  if not found then raise exception 'PRE_ORDER_TERMINAL_RELEASE_CONFLICT'; end if;
  update public.author_preorder_terminal_reviews
  set released_at = v_now, released_by = p_staff_user_id,
      terminal_status = p_provider_terminal_status,
      evidence_reference = p_evidence_reference, verified_at = p_verified_at
  where order_id = p_order_id and released_at is null;
  if not found then raise exception 'PRE_ORDER_TERMINAL_RELEASE_CONFLICT'; end if;
  return jsonb_build_object('order_id', p_order_id, 'released', true, 'reused', false);
end;
$$;

revoke all on function public.author_preorder_release_verified_terminal_hold(uuid,text,uuid,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.author_preorder_release_verified_terminal_hold(uuid,text,uuid,text,text,timestamptz)
  to service_role;
