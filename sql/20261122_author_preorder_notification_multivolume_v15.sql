create or replace function public.author_preorder_notification_settlement_verified(
  p_order_id uuid,
  p_author_page_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.author_preorder_orders%rowtype;
  v_item_count bigint;
  v_unique_books bigint;
  v_subtotal numeric;
  v_legacy_count bigint;
  v_volume_count bigint;
begin
  if p_order_id is null or p_author_page_id is null then
    return false;
  end if;

  select * into v_order
  from public.author_preorder_orders
  where id = p_order_id and author_page_id = p_author_page_id;

  if not found or v_order.payment_status is distinct from 'paid'
     or v_order.paid_at is null or v_order.payment_reference is null
     or v_order.fulfillment_status not in (
       'reserved', 'production', 'shipping', 'completed', 'delayed'
     ) or v_order.buyer_user_id is null or v_order.total_usd <= 0 then
    return false;
  end if;

  if not exists (
    select 1 from public.author_pages p
    where p.id = v_order.author_page_id and p.user_id is not null
  ) or not exists (
    select 1 from public.author_preorder_fee_ledger l
    where l.order_id = p_order_id and l.author_page_id = v_order.author_page_id
  ) or not exists (
    select 1 from public.author_preorder_payment_intents i
    where i.order_id = p_order_id
      and i.merchant_transaction_id = v_order.payment_reference
      and i.currency = 'USD'
      and i.expected_amount_usd = v_order.total_usd
  ) then
    return false;
  end if;

  select count(*), count(distinct book_id),
         coalesce(sum(quantity::numeric * unit_price_usd), 0)
    into v_item_count, v_unique_books, v_subtotal
  from public.author_preorder_order_items
  where order_id = p_order_id;

  if v_item_count not between 1 and 10 or v_unique_books <> v_item_count
     or v_subtotal is distinct from v_order.subtotal_usd
     or v_order.total_usd is distinct from
       (v_subtotal + v_order.signature_fee_usd + v_order.delivery_fee_usd)
     or (v_order.signature_requested is not true
         and v_order.signature_fee_usd <> 0)
     or exists (
       select 1 from public.author_preorder_order_items i
       left join public.author_preorder_books b on b.id = i.book_id
       where i.order_id = p_order_id and (
         b.id is null or b.campaign_id <> v_order.campaign_id
         or i.quantity not between 1 and 99
         or i.unit_price_usd <= 0
         or i.edition not in ('standard', 'limited')
       )
     ) then
    return false;
  end if;

  select count(*) into v_legacy_count
  from public.author_preorder_stock_holds
  where order_id = p_order_id;

  select count(*) into v_volume_count
  from public.author_preorder_volume_holds
  where order_id = p_order_id;

  if v_legacy_count = 1 and v_volume_count = 0 then
    if v_item_count <> 1 or not exists (
      select 1
      from public.author_preorder_stock_holds h
      join public.author_preorder_order_items i
        on i.order_id = h.order_id
       and i.book_id = h.book_id
       and i.edition = h.edition
       and i.quantity = h.quantity
      where h.order_id = p_order_id and h.status = 'consumed'
        and h.consumed_at is not null and h.released_at is null
    ) then
      return false;
    end if;
  elsif v_legacy_count = 0 and v_volume_count = v_item_count then
    if exists (
      select 1
      from public.author_preorder_volume_holds h
      left join public.author_preorder_order_items i
        on i.order_id = h.order_id
       and i.book_id = h.book_id
       and i.edition = h.edition
       and i.quantity = h.quantity
      where h.order_id = p_order_id and (
        h.status <> 'consumed' or h.consumed_at is null
        or h.released_at is not null or i.book_id is null
      )
    ) then
      return false;
    end if;
  else
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.author_preorder_notification_settlement_verified(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.author_preorder_notification_settlement_verified(uuid,uuid)
  to service_role;

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

  if not public.author_preorder_notification_settlement_verified(
    p_order_id, v_order.author_page_id
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

create or replace function public.author_preorder_deliver_inapp_notifications_safe(
  p_limit integer default 5
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
  v_failed integer := 0;
  v_remaining bigint;
  v_error_code text;
  v_now timestamptz;
begin
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'PRE_ORDER_NOTIFY_WORKER_LIMIT_INVALID';
  end if;

  for v_job in
    select *
    from public.author_preorder_paid_notification_outbox
    where delivery_state in ('queued', 'failed')
      and delivered_at is null
      and attempt_count < 8
      and next_attempt_at <= clock_timestamp()
    order by next_attempt_at, created_at, id
    limit p_limit
    for update skip locked
  loop
    begin
      select o.id, o.campaign_id, o.author_page_id, o.buyer_user_id,
             p.user_id as author_user_id
      into v_order
      from public.author_preorder_orders o
      join public.author_pages p on p.id = o.author_page_id
      where o.id = v_job.order_id;

      if not found or v_order.author_page_id is distinct from v_job.author_page_id
         or not public.author_preorder_notification_settlement_verified(
           v_job.order_id, v_job.author_page_id
         ) then
        raise exception 'PRE_ORDER_NOTIFY_WORKER_SETTLEMENT_INVALID';
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
        raise exception 'PRE_ORDER_NOTIFY_WORKER_ROLE_INVALID';
      end if;

      if v_recipient is null then
        raise exception 'PRE_ORDER_NOTIFY_WORKER_RECIPIENT_MISSING';
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
        raise exception 'PRE_ORDER_NOTIFY_WORKER_INSERT_UNCONFIRMED';
      end if;

      v_now := clock_timestamp();
      update public.author_preorder_paid_notification_outbox
      set delivery_state = 'sent',
          attempt_count = least(100, attempt_count + 1),
          claimed_at = v_now,
          delivered_at = v_now,
          last_error_code = null,
          updated_at = v_now
      where id = v_job.id
        and delivery_state in ('queued', 'failed')
        and delivered_at is null;
      if not found then
        raise exception 'PRE_ORDER_NOTIFY_WORKER_QUEUE_CONFLICT';
      end if;

      v_delivered := v_delivered + 1;
      if v_created = 1 then
        v_new := v_new + 1;
      else
        v_existing := v_existing + 1;
      end if;
    exception when others then
      v_error_code := case
        when sqlerrm ~ '^PRE_ORDER_[A-Z0-9_]{3,80}$' then sqlerrm
        else 'PRE_ORDER_NOTIFY_WORKER_RETRY_REQUIRED'
      end;
      v_now := clock_timestamp();
      update public.author_preorder_paid_notification_outbox
      set delivery_state = 'failed',
          attempt_count = least(100, attempt_count + 1),
          claimed_at = v_now,
          next_attempt_at = v_now + make_interval(
            secs => (60 * power(2, least(5, attempt_count)))::integer
          ),
          last_error_code = v_error_code,
          updated_at = v_now
      where id = v_job.id
        and delivery_state in ('queued', 'failed')
        and delivered_at is null;
      if not found then
        raise exception 'PRE_ORDER_NOTIFY_WORKER_FAILURE_MARK_CONFLICT';
      end if;
      v_failed := v_failed + 1;
    end;
  end loop;

  select count(*) into v_remaining
  from public.author_preorder_paid_notification_outbox
  where delivery_state in ('queued', 'failed')
    and attempt_count < 8
    and delivered_at is null
    and next_attempt_at <= clock_timestamp();

  return jsonb_build_object(
    'delivered_jobs', v_delivered,
    'new_notifications', v_new,
    'existing_notifications', v_existing,
    'failed_jobs', v_failed,
    'remaining_ready', v_remaining
  );
end;
$$;

revoke all on function public.author_preorder_deliver_inapp_notifications_safe(integer)
  from public, anon, authenticated;
grant execute on function public.author_preorder_deliver_inapp_notifications_safe(integer)
  to service_role;

create or replace function public.author_preorder_deliver_inapp_notifications(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_batch jsonb;
  v_batch_limit integer;
  v_processed integer := 0;
  v_delivered integer := 0;
  v_new integer := 0;
  v_existing integer := 0;
  v_failed integer := 0;
  v_remaining bigint := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'PRE_ORDER_NOTIFY_BATCH_LIMIT_INVALID';
  end if;

  while v_processed < p_limit loop
    v_batch_limit := least(10, p_limit - v_processed);
    v_batch := public.author_preorder_deliver_inapp_notifications_safe(v_batch_limit);
    v_delivered := v_delivered + (v_batch->>'delivered_jobs')::integer;
    v_new := v_new + (v_batch->>'new_notifications')::integer;
    v_existing := v_existing + (v_batch->>'existing_notifications')::integer;
    v_failed := v_failed + (v_batch->>'failed_jobs')::integer;
    v_remaining := (v_batch->>'remaining_ready')::bigint;
    v_processed := v_processed + (v_batch->>'delivered_jobs')::integer
                             + (v_batch->>'failed_jobs')::integer;
    if (v_batch->>'delivered_jobs')::integer + (v_batch->>'failed_jobs')::integer = 0
       or v_remaining = 0 then
      exit;
    end if;
  end loop;

  return jsonb_build_object(
    'delivered_jobs', v_delivered,
    'new_notifications', v_new,
    'existing_notifications', v_existing,
    'failed_jobs', v_failed,
    'remaining_ready', v_remaining
  );
end;
$$;

revoke all on function public.author_preorder_deliver_inapp_notifications(integer)
  from public, anon, authenticated;
grant execute on function public.author_preorder_deliver_inapp_notifications(integer)
  to service_role;
