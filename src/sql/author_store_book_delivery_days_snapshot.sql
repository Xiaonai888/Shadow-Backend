begin;

alter table public.author_store_book_payment_holds
  add column if not exists actual_delivery_days integer
  check (actual_delivery_days is null or actual_delivery_days >= 0);

create or replace function public.capture_author_store_book_actual_delivery_days()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_payment_at timestamptz;
  v_days numeric;
begin
  if old.actual_delivery_days is not null then
    new.actual_delivery_days := old.actual_delivery_days;
    return new;
  end if;

  if new.status is distinct from 'released'
     or new.release_source is distinct from 'reader'
     or new.reader_confirmed_at is null
     or old.status is not distinct from new.status then
    return new;
  end if;

  select coalesce(o.paid_at, o.confirmed_at)
    into v_payment_at
    from public.author_store_orders o
    where o.id = new.order_id
      and o.payment_status = 'paid'
      and exists (
        select 1
        from public.author_store_book_hold_activation a
        where a.id = 1
          and o.created_at >= a.activated_at
      );

  if v_payment_at is null then
    return new;
  end if;

  v_days := greatest(
    0,
    floor(extract(epoch from (new.reader_confirmed_at - v_payment_at)) / 86400)
  );

  if v_days <= 2147483647 then
    new.actual_delivery_days := v_days::integer;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_author_store_book_actual_delivery_days
  on public.author_store_book_payment_holds;

create trigger trg_author_store_book_actual_delivery_days
  before update of status, reader_confirmed_at
  on public.author_store_book_payment_holds
  for each row
  execute function public.capture_author_store_book_actual_delivery_days();

revoke all on function public.capture_author_store_book_actual_delivery_days()
  from public, anon, authenticated;

grant execute on function public.capture_author_store_book_actual_delivery_days()
  to service_role;

commit;
