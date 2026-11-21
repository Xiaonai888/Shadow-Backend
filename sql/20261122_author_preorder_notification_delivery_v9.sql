create unique index if not exists author_preorder_paid_notification_ref_unique_idx
  on public.notifications (user_id, reference_id)
  where reference_id like 'author-preorder-paid:%';

create or replace function public.author_preorder_deliver_inapp_notifications(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job public.author_preorder_paid_notification_outbox%rowtype;
  v_order record;
  v_recipient uuid;
  v_reference text;
  v_title text;
  v_message text;
  v_link text;
  v_created integer;
  v_confirmed integer;
  v_delivered integer := 0;
  v_new integer := 0;
  v_existing integer := 0;
  v_remaining bigint;
begin
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'PRE_ORDER_NOTIFY_BATCH_LIMIT_INVALID';
  end if;

  for v_job in
    select *
    from public.author_preorder_paid_notification_outbox
    where delivery_state in ('queued', 'failed')
      and attempt_count < 8
      and delivered_at is null
      and next_attempt_at <= clock_timestamp()
    order by next_attempt_at, created_at, id
    limit p_limit
    for update skip locked
  loop
    select o.*, p.user_id as author_user_id
    into v_order
    from public.author_preorder_orders o
    join public.author_pages p on p.id = o.author_page_id
    where o.id = v_job.order_id;

    if not found or v_job.author_page_id is distinct from v_order.author_page_id
       or v_order.payment_status is distinct from 'paid'
       or v_order.paid_at is null or v_order.payment_reference is null
       or v_order.fulfillment_status not in ('reserved','production','shipping','completed','delayed') then
      raise exception 'PRE_ORDER_NOTIFY_DELIVERY_ORDER_INVALID';
    end if;

    if not exists (
      select 1 from public.author_preorder_fee_ledger l
      where l.order_id = v_order.id and l.author_page_id = v_order.author_page_id
    ) or not exists (
      select 1 from public.author_preorder_stock_holds h
      where h.order_id = v_order.id and h.status = 'consumed'
    ) or not exists (
      select 1 from public.author_preorder_payment_intents i
      where i.order_id = v_order.id
        and i.merchant_transaction_id = v_order.payment_reference
        and i.expected_amount_usd = v_order.total_usd
        and i.currency = 'USD'
    ) then
      raise exception 'PRE_ORDER_NOTIFY_DELIVERY_SETTLEMENT_INVALID';
    end if;

    if v_job.recipient_role = 'buyer' then
      v_recipient := v_order.buyer_user_id;
      v_title := 'Pre-order payment confirmed';
      v_message := 'Your payment was verified and your book order is reserved.';
      v_link := '/store/pre-orders/' || v_order.campaign_id::text;
    elsif v_job.recipient_role = 'author' then
      v_recipient := v_order.author_user_id;
      v_title := 'New paid pre-order';
      v_message := 'A paid pre-order is ready for preparation.';
      v_link := '/author/page/pre-order/orders';
    else
      raise exception 'PRE_ORDER_NOTIFY_DELIVERY_ROLE_INVALID';
    end if;

    if v_recipient is null then
      raise exception 'PRE_ORDER_NOTIFY_DELIVERY_RECIPIENT_MISSING';
    end if;

    v_reference := 'author-preorder-paid:' || v_job.recipient_role || ':' || v_order.id::text;

    insert into public.notifications (
      user_id, type, title, message, image_url, link, reference_id, is_read
    ) values (
      v_recipient, 'announcements', v_title, v_message, '', v_link,
      v_reference, false
    ) on conflict do nothing;
    get diagnostics v_created = row_count;

    select count(*) into v_confirmed
    from public.notifications n
    where n.user_id = v_recipient
      and n.reference_id = v_reference
      and n.type = 'announcements';

    if v_confirmed <> 1 then
      raise exception 'PRE_ORDER_NOTIFY_DELIVERY_NOT_CONFIRMED';
    end if;

    update public.author_preorder_paid_notification_outbox
    set delivery_state = 'sent',
        attempt_count = least(100, attempt_count + 1),
        claimed_at = clock_timestamp(),
        delivered_at = clock_timestamp(),
        last_error_code = null,
        updated_at = clock_timestamp()
    where id = v_job.id and delivery_state in ('queued','failed')
      and delivered_at is null;

    if not found then
      raise exception 'PRE_ORDER_NOTIFY_DELIVERY_QUEUE_CONFLICT';
    end if;

    v_delivered := v_delivered + 1;
    if v_created = 1 then
      v_new := v_new + 1;
    else
      v_existing := v_existing + 1;
    end if;
  end loop;

  select count(*) into v_remaining
  from public.author_preorder_paid_notification_outbox
  where delivery_state in ('queued','failed')
    and attempt_count < 8
    and next_attempt_at <= clock_timestamp();

  return jsonb_build_object(
    'delivered_jobs', v_delivered,
    'new_notifications', v_new,
    'existing_notifications', v_existing,
    'remaining_ready', v_remaining
  );
end;
$$;

revoke all on function public.author_preorder_deliver_inapp_notifications(integer)
  from public, anon, authenticated;
grant execute on function public.author_preorder_deliver_inapp_notifications(integer)
  to service_role;

create or replace function public.author_preorder_notification_health()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'queued', count(*) filter (where delivery_state = 'queued'),
    'failed', count(*) filter (where delivery_state = 'failed'),
    'processing', count(*) filter (where delivery_state = 'processing'),
    'sent', count(*) filter (where delivery_state = 'sent'),
    'ready', count(*) filter (
      where delivery_state in ('queued','failed')
      and attempt_count < 8 and next_attempt_at <= now()
    ),
    'oldest_pending_at', min(created_at) filter (
      where delivery_state in ('queued','failed','processing')
    )
  )
  from public.author_preorder_paid_notification_outbox;
$$;

revoke all on function public.author_preorder_notification_health()
  from public, anon, authenticated;
grant execute on function public.author_preorder_notification_health()
  to service_role;
