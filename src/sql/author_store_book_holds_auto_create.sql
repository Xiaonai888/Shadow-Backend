begin;

alter table public.author_store_book_payment_hold_events
  drop constraint if exists author_store_book_payment_hold_events_action_check;

alter table public.author_store_book_payment_hold_events
  add constraint author_store_book_payment_hold_events_action_check
  check (action in (
    'created', 'income_adjusted', 'shipment_updated', 'review_requested',
    'reader_confirmed', 'admin_approved', 'released', 'refunded'
  ));

create or replace function public.sync_author_store_paid_book_hold()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  book_count bigint;
  item_count bigint;
  book_income_cents bigint;
  shipping_cents bigint;
  new_hold_cents bigint;
  existing_hold public.author_store_book_payment_holds%rowtype;
  inserted_hold_id uuid;
begin
  if new.payment_status is distinct from 'paid' then
    return new;
  end if;

  select count(*),
         count(*) filter (where lower(btrim(coalesce(product_type, ''))) = 'book'),
         coalesce(sum(
           round(coalesce(author_income_usd, 0)::numeric * 100)::bigint
         ) filter (where lower(btrim(coalesce(product_type, ''))) = 'book'), 0)
    into item_count, book_count, book_income_cents
    from public.author_store_order_items
    where order_id = new.id;

  if item_count = 0 then
    if coalesce(new.author_income_usd, 0) > 0 or coalesce(new.delivery_fee_usd, 0) > 0 then
      raise exception 'Paid author store order % has no order items', new.id;
    end if;
    return new;
  end if;

  if book_count = 0 then
    return new;
  end if;

  shipping_cents := round(coalesce(new.delivery_fee_usd, 0)::numeric * 100)::bigint;
  if book_income_cents < 0 or shipping_cents < 0 then
    raise exception 'Invalid book income for paid order %', new.id;
  end if;

  new_hold_cents := book_income_cents + shipping_cents;
  if new_hold_cents <= 0 then
    return new;
  end if;

  select * into existing_hold
    from public.author_store_book_payment_holds
    where order_id = new.id
    for update;

  if not found then
    insert into public.author_store_book_payment_holds (
      order_id, author_page_id, buyer_id, held_amount_cents, status
    ) values (
      new.id, new.author_page_id, new.buyer_id, new_hold_cents, 'awaiting_reader'
    )
    on conflict (order_id) do nothing
    returning id into inserted_hold_id;

    if inserted_hold_id is not null then
      insert into public.author_store_book_payment_hold_events (
        hold_id, action, actor_type, reason
      ) values (
        inserted_hold_id, 'created', 'system', 'Verified physical book payment'
      );
      return new;
    end if;

    select * into existing_hold
      from public.author_store_book_payment_holds
      where order_id = new.id
      for update;
  end if;

  if existing_hold.id is null
     or existing_hold.author_page_id is distinct from new.author_page_id then
    raise exception 'Physical book hold ownership mismatch for order %', new.id;
  end if;

  if existing_hold.held_amount_cents = new_hold_cents then
    return new;
  end if;

  if existing_hold.status not in ('awaiting_reader', 'under_review') then
    raise exception 'Cannot recalculate finalized book hold for order %', new.id;
  end if;

  update public.author_store_book_payment_holds
    set held_amount_cents = new_hold_cents, updated_at = now()
    where id = existing_hold.id;

  insert into public.author_store_book_payment_hold_events (
    hold_id, action, actor_type, reason
  ) values (
    existing_hold.id,
    'income_adjusted',
    'system',
    format('Amount updated from %s to %s cents', existing_hold.held_amount_cents, new_hold_cents)
  );

  return new;
end;
$$;

drop trigger if exists trg_author_store_paid_book_hold on public.author_store_orders;

create trigger trg_author_store_paid_book_hold
  after insert or update of payment_status, author_income_usd,
    delivery_fee_usd, status, order_status
  on public.author_store_orders
  for each row
  execute function public.sync_author_store_paid_book_hold();

commit;
