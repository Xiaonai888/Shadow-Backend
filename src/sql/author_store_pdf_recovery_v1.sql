create table if not exists public.author_store_pdf_recovery_jobs (
  order_id uuid primary key,
  buyer_id uuid not null,
  order_number text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'review_required')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_result text,
  last_error text,
  last_checked_at timestamptz,
  alert_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists author_store_pdf_recovery_jobs_due_idx
  on public.author_store_pdf_recovery_jobs (status, next_attempt_at);

create table if not exists public.author_store_pdf_recovery_actions (
  id bigint generated always as identity primary key,
  order_id uuid not null,
  order_number text not null,
  buyer_id uuid not null,
  source text not null check (source in ('auto', 'admin')),
  result text not null,
  payment_status_before text,
  pdf_status_before text,
  error_message text,
  admin_id text,
  admin_email text,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists author_store_pdf_recovery_actions_order_idx
  on public.author_store_pdf_recovery_actions (order_id, created_at desc);

create table if not exists public.author_store_pdf_manual_settlements (
  id bigint generated always as identity primary key,
  order_id uuid not null unique,
  buyer_id uuid not null,
  bank_reference text not null,
  verified_amount_usd numeric(12,2) not null check (verified_amount_usd > 0),
  bank_paid_at timestamptz not null,
  admin_id text not null,
  admin_email text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists author_store_pdf_manual_settlements_bank_ref_idx
  on public.author_store_pdf_manual_settlements (lower(bank_reference));

alter table public.author_store_pdf_recovery_jobs enable row level security;
alter table public.author_store_pdf_recovery_actions enable row level security;
alter table public.author_store_pdf_manual_settlements enable row level security;

revoke all on table public.author_store_pdf_recovery_jobs from anon, authenticated;
revoke all on table public.author_store_pdf_recovery_actions from anon, authenticated;
revoke all on table public.author_store_pdf_manual_settlements from anon, authenticated;

grant all on table public.author_store_pdf_recovery_jobs to service_role;
grant all on table public.author_store_pdf_recovery_actions to service_role;
grant all on table public.author_store_pdf_manual_settlements to service_role;
grant usage, select on sequence public.author_store_pdf_recovery_actions_id_seq to service_role;
grant usage, select on sequence public.author_store_pdf_manual_settlements_id_seq to service_role;

create or replace view public.author_store_pdf_recovery_index_v1
with (security_invoker = true)
as
select
  o.id,
  o.order_id,
  o.buyer_id,
  o.buyer_name,
  o.buyer_phone,
  o.total_usd,
  o.currency,
  o.status,
  o.payment_status,
  o.pdf_unlock_status,
  o.created_at,
  o.expires_at,
  o.paid_at,
  o.aba_transaction_id,
  o.telegram_status,
  o.telegram_error,
  count(distinct i.product_id)::integer as pdf_count,
  count(distinct case when d.product_id is not null then i.product_id end)::integer as granted_count,
  case
    when lower(coalesce(o.payment_status, '')) = 'paid'
      and lower(coalesce(o.pdf_unlock_status, '')) = 'unlocked'
      and count(distinct i.product_id) = count(distinct case when d.product_id is not null then i.product_id end)
      then 'delivered'
    when lower(coalesce(o.payment_status, '')) = 'paid' then 'needs_recovery'
    else 'not_paid'
  end as delivery_status
from public.author_store_orders o
join public.author_store_order_items i
  on i.order_id = o.id and lower(coalesce(i.product_type, '')) = 'pdf'
left join public.author_store_reader_downloads d
  on d.buyer_id = o.buyer_id and d.product_id = i.product_id
group by o.id;

revoke all on public.author_store_pdf_recovery_index_v1 from anon, authenticated;
grant select on public.author_store_pdf_recovery_index_v1 to service_role;

create or replace function public.admin_author_store_pdf_manual_confirm_v1(
  p_order_id uuid,
  p_buyer_id uuid,
  p_bank_reference text,
  p_verified_amount_usd numeric,
  p_bank_paid_at timestamptz,
  p_admin_id text,
  p_admin_email text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.author_store_orders%rowtype;
  v_item_count integer;
  v_pdf_count integer;
  v_reference text := trim(coalesce(p_bank_reference, ''));
  v_existing_reference uuid;
  v_existing_manual public.author_store_pdf_manual_settlements%rowtype;
begin
  if p_order_id is null or p_buyer_id is null or
     v_reference !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{5,99}$' or
     p_verified_amount_usd is null or p_verified_amount_usd <= 0 or
     p_bank_paid_at is null or p_bank_paid_at > now() + interval '5 minutes' or
     length(trim(coalesce(p_admin_id, ''))) = 0 or
     length(trim(coalesce(p_admin_email, ''))) = 0 or
     length(trim(coalesce(p_reason, ''))) < 12 or
     length(trim(coalesce(p_reason, ''))) > 500 then
    raise exception 'Invalid manual PDF payment confirmation';
  end if;

  select * into v_order
  from public.author_store_orders
  where id = p_order_id and buyer_id = p_buyer_id
  for update;

  if not found then
    raise exception 'PDF order or buyer not found';
  end if;

  if lower(coalesce(v_order.payment_status, '')) = 'paid' then
    select * into v_existing_manual
    from public.author_store_pdf_manual_settlements
    where order_id = p_order_id;
    if found and lower(v_existing_manual.bank_reference) = lower(v_reference) then
      return jsonb_build_object('ok', true, 'already_confirmed', true, 'order_id', v_order.order_id);
    end if;
    raise exception 'Payment is already confirmed; use PDF recovery';
  end if;

  if lower(coalesce(v_order.payment_status, '')) <> 'pending' or
     lower(coalesce(v_order.status, '')) not in ('waiting_payment', 'expired') then
    raise exception 'Order state does not permit manual payment confirmation';
  end if;

  if lower(coalesce(v_order.currency, 'USD')) <> 'usd' or
     abs(coalesce(v_order.total_usd, 0) - p_verified_amount_usd) > 0.009 then
    raise exception 'Confirmed bank amount must match the original order in USD';
  end if;

  if lower(coalesce(v_order.request_payload->>'payment_method', 'aba')) like '%binance%' or
     coalesce(v_order.request_payload->>'binance_purchase_id', '') <> '' then
    raise exception 'Binance PDF orders must use Binance verification';
  end if;

  select count(*), count(*) filter (where lower(coalesce(product_type, '')) = 'pdf'
    and quantity = 1 and product_id is not null)
  into v_item_count, v_pdf_count
  from public.author_store_order_items
  where order_id = p_order_id;

  if v_item_count = 0 or v_item_count <> v_pdf_count then
    raise exception 'Only PDF-only orders can be confirmed here';
  end if;

  select id into v_existing_reference
  from public.author_store_orders
  where id <> p_order_id and lower(coalesce(aba_transaction_id, '')) = lower(v_reference)
  limit 1;

  if found then
    raise exception 'Bank reference is already assigned to a different order';
  end if;

  if exists (
    select 1 from public.payment_transactions
    where lower(coalesce(aba_trx_id, '')) = lower(v_reference)
  ) then
    raise exception 'Bank reference is already used for another payment';
  end if;

  insert into public.author_store_pdf_manual_settlements (
    order_id, buyer_id, bank_reference, verified_amount_usd,
    bank_paid_at, admin_id, admin_email, reason
  ) values (
    p_order_id, p_buyer_id, v_reference, p_verified_amount_usd,
    p_bank_paid_at, trim(p_admin_id), lower(trim(p_admin_email)), trim(p_reason)
  );

  update public.author_store_orders
  set status = 'under_review',
      order_status = 'under_review',
      payment_status = 'paid',
      aba_transaction_id = coalesce(nullif(aba_transaction_id, ''), v_reference),
      paid_at = p_bank_paid_at,
      updated_at = now()
  where id = p_order_id and buyer_id = p_buyer_id
    and payment_status = 'pending';

  if not found then
    raise exception 'Order payment state changed during verification';
  end if;

  return jsonb_build_object('ok', true, 'already_confirmed', false, 'order_id', v_order.order_id);
end;
$$;

revoke all on function public.admin_author_store_pdf_manual_confirm_v1(
  uuid, uuid, text, numeric, timestamptz, text, text, text
) from public, anon, authenticated;

grant execute on function public.admin_author_store_pdf_manual_confirm_v1(
  uuid, uuid, text, numeric, timestamptz, text, text, text
) to service_role;
