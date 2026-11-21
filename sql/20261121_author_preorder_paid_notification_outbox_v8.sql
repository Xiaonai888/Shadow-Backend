create table if not exists public.author_preorder_paid_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.author_preorder_orders(id) on delete restrict,
  author_page_id uuid not null references public.author_pages(id) on delete restrict,
  recipient_role text not null,
  delivery_state text not null default 'queued',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, recipient_role),
  constraint author_preorder_notification_recipient_chk check (recipient_role in ('buyer','author')),
  constraint author_preorder_notification_state_chk check (delivery_state in ('queued','processing','sent','failed')),
  constraint author_preorder_notification_attempts_chk check (attempt_count between 0 and 100),
  constraint author_preorder_notification_delivery_chk check (
    (delivery_state = 'sent' and delivered_at is not null)
    or (delivery_state <> 'sent' and delivered_at is null)
  ),
  constraint author_preorder_notification_error_chk check (
    last_error_code is null or last_error_code ~ '^PRE_ORDER_[A-Z0-9_]{3,80}$'
  )
);

create index if not exists author_preorder_paid_notification_pending_idx
  on public.author_preorder_paid_notification_outbox (next_attempt_at, id)
  where delivery_state in ('queued','failed');

create index if not exists author_preorder_paid_notification_author_idx
  on public.author_preorder_paid_notification_outbox (author_page_id, created_at desc);

alter table public.author_preorder_paid_notification_outbox enable row level security;
revoke all on table public.author_preorder_paid_notification_outbox from public, anon, authenticated;
grant select, insert, update on public.author_preorder_paid_notification_outbox to service_role;

create or replace function public.author_preorder_queue_verified_paid_notifications(
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.author_preorder_orders%rowtype;
  v_inserted integer;
  v_count integer;
begin
  if p_order_id is null then
    raise exception 'PRE_ORDER_NOTIFY_ORDER_REQUIRED';
  end if;

  select * into v_order
  from public.author_preorder_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'PRE_ORDER_NOTIFY_ORDER_NOT_FOUND';
  end if;

  if v_order.payment_status <> 'paid' or v_order.paid_at is null
     or v_order.fulfillment_status not in ('reserved','production','shipping','completed','delayed')
     or v_order.payment_reference is null then
    raise exception 'PRE_ORDER_NOTIFY_PAYMENT_NOT_VERIFIED';
  end if;

  if not exists (
    select 1 from public.author_preorder_fee_ledger l
    where l.order_id = p_order_id and l.author_page_id = v_order.author_page_id
  ) or not exists (
    select 1 from public.author_preorder_stock_holds h
    where h.order_id = p_order_id and h.status = 'consumed'
  ) or not exists (
    select 1 from public.author_preorder_payment_intents i
    where i.order_id = p_order_id and i.merchant_transaction_id = v_order.payment_reference
      and i.currency = 'USD' and i.expected_amount_usd = v_order.total_usd
  ) then
    raise exception 'PRE_ORDER_NOTIFY_SETTLEMENT_INCOMPLETE';
  end if;

  insert into public.author_preorder_paid_notification_outbox (
    order_id, author_page_id, recipient_role
  )
  select p_order_id, v_order.author_page_id, recipient.role
  from (values ('buyer'::text), ('author'::text)) as recipient(role)
  on conflict (order_id, recipient_role) do nothing;

  get diagnostics v_inserted = row_count;

  select count(*) into v_count
  from public.author_preorder_paid_notification_outbox n
  where n.order_id = p_order_id
    and n.author_page_id = v_order.author_page_id
    and n.recipient_role in ('buyer', 'author');

  if v_count <> 2 then
    raise exception 'PRE_ORDER_NOTIFY_OUTBOX_CONFLICT';
  end if;

  return jsonb_build_object(
    'order_id', p_order_id,
    'recipient_jobs', v_count,
    'new_jobs', v_inserted,
    'already_queued', v_inserted = 0
  );
end;
$$;

revoke all on function public.author_preorder_queue_verified_paid_notifications(uuid)
  from public, anon, authenticated;
grant execute on function public.author_preorder_queue_verified_paid_notifications(uuid)
  to service_role;
