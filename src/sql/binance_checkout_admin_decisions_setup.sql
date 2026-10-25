begin;

create table if not exists public.binance_checkout_admin_decisions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.binance_checkout_orders(id) on delete restrict,
  user_id uuid not null references public.users(id) on delete restrict,
  transaction_id text not null,
  decision text not null check (decision in ('approved', 'rejected')),
  credit_action_id uuid unique references public.admin_binance_usdt_credit_actions(id) on delete restrict,
  reason text not null check (char_length(btrim(reason)) between 12 and 500),
  admin_id text not null check (char_length(btrim(admin_id)) between 2 and 120),
  admin_email text not null check (char_length(btrim(admin_email)) between 5 and 320),
  created_at timestamptz not null default now(),
  constraint binance_checkout_admin_decision_credit_check check (
    (decision = 'approved' and credit_action_id is not null)
    or (decision = 'rejected' and credit_action_id is null)
  )
);

create index if not exists binance_checkout_admin_decisions_history_idx
  on public.binance_checkout_admin_decisions (created_at desc, id desc);

alter table public.binance_checkout_admin_decisions enable row level security;
revoke all on public.binance_checkout_admin_decisions from public, anon, authenticated;
grant select, insert on public.binance_checkout_admin_decisions to service_role;

create or replace function public.reject_binance_checkout_admin_decision_v1(
  p_order_id uuid,
  p_admin_id text,
  p_admin_email text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.binance_checkout_orders%rowtype;
  v_claim public.binance_checkout_claims%rowtype;
  v_decision public.binance_checkout_admin_decisions%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_order_id is null or char_length(v_reason) not between 12 and 500
    or char_length(btrim(coalesce(p_admin_id, ''))) not between 2 and 120
    or char_length(btrim(coalesce(p_admin_email, ''))) not between 5 and 320 then
    raise exception 'INVALID_BINANCE_ADMIN_DECISION';
  end if;

  select * into v_order from public.binance_checkout_orders
  where id = p_order_id for update;
  if not found then raise exception 'BINANCE_CHECKOUT_NOT_FOUND'; end if;

  select * into v_claim from public.binance_checkout_claims
  where order_id = p_order_id for update;
  if not found then raise exception 'BINANCE_CLAIM_NOT_FOUND'; end if;

  if v_order.status = 'credited' or v_claim.review_status = 'approved' then
    raise exception 'BINANCE_CHECKOUT_ALREADY_CREDITED';
  end if;

  if v_order.status <> 'pending_review' or v_claim.review_status <> 'submitted' then
    raise exception 'BINANCE_CHECKOUT_NOT_PENDING_REVIEW';
  end if;

  update public.binance_checkout_orders
  set status = 'cancelled', updated_at = now()
  where id = v_order.id;

  update public.binance_checkout_claims
  set review_status = 'rejected', reviewed_at = now(), updated_at = now()
  where order_id = v_order.id;

  insert into public.binance_checkout_admin_decisions (
    order_id, user_id, transaction_id, decision, reason, admin_id, admin_email
  ) values (
    v_order.id, v_order.user_id, v_claim.transaction_id, 'rejected',
    v_reason, btrim(p_admin_id), lower(btrim(p_admin_email))
  ) returning * into v_decision;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order.id,
    'status', 'rejected',
    'decision_id', v_decision.id,
    'credit_applied', false
  );
end;
$$;

create or replace function public.approve_binance_checkout_admin_decision_v1(
  p_order_id uuid,
  p_admin_id text,
  p_admin_email text,
  p_reason text,
  p_official_receipt_verified boolean,
  p_reader_verified boolean,
  p_receiver_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.binance_checkout_orders%rowtype;
  v_claim public.binance_checkout_claims%rowtype;
  v_receipt public.binance_usdt_alert_transactions%rowtype;
  v_decision public.binance_checkout_admin_decisions%rowtype;
  v_credit jsonb;
  v_credit_id uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_order_id is null or char_length(v_reason) not between 12 and 500
    or char_length(btrim(coalesce(p_admin_id, ''))) not between 2 and 120
    or char_length(btrim(coalesce(p_admin_email, ''))) not between 5 and 320 then
    raise exception 'INVALID_BINANCE_ADMIN_DECISION';
  end if;

  if p_official_receipt_verified is distinct from true
    or p_reader_verified is distinct from true
    or p_receiver_verified is distinct from true then
    raise exception 'BINANCE_MANUAL_CONFIRMATIONS_REQUIRED';
  end if;

  select * into v_order from public.binance_checkout_orders
  where id = p_order_id for update;
  if not found then raise exception 'BINANCE_CHECKOUT_NOT_FOUND'; end if;

  select * into v_claim from public.binance_checkout_claims
  where order_id = p_order_id for update;
  if not found then raise exception 'BINANCE_CLAIM_NOT_FOUND'; end if;

  if v_order.status = 'credited' and v_claim.review_status = 'approved' then
    select * into v_decision from public.binance_checkout_admin_decisions
    where order_id = p_order_id and decision = 'approved';
    if not found then raise exception 'BINANCE_CREDIT_AUDIT_MISSING'; end if;
    return jsonb_build_object(
      'ok', true, 'order_id', p_order_id, 'status', 'credited',
      'decision_id', v_decision.id, 'credit_action_id', v_decision.credit_action_id,
      'credit_applied', false, 'already_credited', true
    );
  end if;

  if v_order.status <> 'pending_review' or v_claim.review_status <> 'submitted' then
    raise exception 'BINANCE_CHECKOUT_NOT_PENDING_REVIEW';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('admin-payment-reference:' || upper(btrim(v_claim.transaction_id)), 0)
  );

  select * into v_receipt from public.binance_usdt_alert_transactions
  where transaction_id = v_claim.transaction_id for update;
  if not found then raise exception 'BINANCE_OFFICIAL_RECEIPT_NOT_FOUND'; end if;

  if v_receipt.currency <> 'USDT' or v_receipt.amount is distinct from v_order.amount_usdt then
    raise exception 'BINANCE_RECEIPT_AMOUNT_MISMATCH';
  end if;

  if v_receipt.transaction_time_ms < (
    extract(epoch from v_order.created_at) * 1000 - 60000
  )::bigint or v_receipt.transaction_time_ms > (
    extract(epoch from v_order.expires_at) * 1000 + 600000
  )::bigint then
    raise exception 'BINANCE_RECEIPT_TIME_MISMATCH';
  end if;

  if v_order.verified_transaction_id is not null or v_order.credited_at is not null then
    raise exception 'BINANCE_CHECKOUT_ALREADY_CREDITED';
  end if;

  v_credit := public.admin_binance_usdt_credit_apply_v1(
    'recovery', v_order.user_id, v_claim.transaction_id, v_claim.transaction_id,
    v_receipt.amount, v_order.diamonds, p_admin_id, p_admin_email,
    v_reason, true, true
  );

  if v_credit->>'ok' <> 'true' or (v_credit->>'transaction_id') is distinct from v_claim.transaction_id
    or (v_credit->>'user_id') is distinct from v_order.user_id::text
    or (v_credit->>'diamonds')::integer is distinct from v_order.diamonds
    or (v_credit->>'bonus_vouchers')::integer is distinct from v_order.bonus_vouchers then
    raise exception 'BINANCE_CREDIT_CONFIRMATION_MISMATCH';
  end if;
  v_credit_id := (v_credit->>'action_id')::uuid;

  update public.binance_checkout_orders
  set status = 'credited', verified_transaction_id = v_claim.transaction_id,
      verified_at = now(), credited_at = now(), updated_at = now()
  where id = v_order.id;

  update public.binance_checkout_claims
  set review_status = 'approved', reviewed_at = now(), updated_at = now()
  where order_id = v_order.id;

  insert into public.binance_checkout_admin_decisions (
    order_id, user_id, transaction_id, decision, credit_action_id,
    reason, admin_id, admin_email
  ) values (
    v_order.id, v_order.user_id, v_claim.transaction_id, 'approved', v_credit_id,
    v_reason, btrim(p_admin_id), lower(btrim(p_admin_email))
  ) returning * into v_decision;

  return jsonb_build_object(
    'ok', true, 'order_id', v_order.id, 'status', 'credited',
    'transaction_id', v_claim.transaction_id, 'decision_id', v_decision.id,
    'credit_action_id', v_credit_id, 'diamonds', v_order.diamonds,
    'bonus_vouchers', v_order.bonus_vouchers, 'credit_applied', true
  );
end;
$$;

revoke all on function public.reject_binance_checkout_admin_decision_v1(uuid,text,text,text)
  from public, anon, authenticated;
revoke all on function public.approve_binance_checkout_admin_decision_v1(uuid,text,text,text,boolean,boolean,boolean)
  from public, anon, authenticated;
grant execute on function public.reject_binance_checkout_admin_decision_v1(uuid,text,text,text)
  to service_role;
grant execute on function public.approve_binance_checkout_admin_decision_v1(uuid,text,text,text,boolean,boolean,boolean)
  to service_role;

commit;
