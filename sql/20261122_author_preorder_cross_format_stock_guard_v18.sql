create or replace function public.author_preorder_cross_format_stock_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_book public.author_preorder_books%rowtype;
  v_legacy_held bigint;
  v_multi_held bigint;
  v_reserved bigint;
  v_quota bigint;
  v_enabled boolean;
begin
  if new.status is distinct from 'held' then
    return new;
  end if;

  if new.book_id is null or new.edition not in ('standard', 'limited')
     or new.quantity is null or new.quantity not between 1 and 99 then
    raise exception 'PRE_ORDER_CROSS_FORMAT_HOLD_INVALID';
  end if;

  select * into v_book
  from public.author_preorder_books
  where id = new.book_id
  for update;

  if not found then
    raise exception 'PRE_ORDER_CROSS_FORMAT_BOOK_MISSING';
  end if;

  select coalesce(sum(h.quantity), 0)::bigint into v_legacy_held
  from public.author_preorder_stock_holds h
  where h.book_id = new.book_id and h.edition = new.edition
    and h.status = 'held'
    and (tg_table_name <> 'author_preorder_stock_holds' or h.order_id <> new.order_id);

  select coalesce(sum(h.quantity), 0)::bigint into v_multi_held
  from public.author_preorder_volume_holds h
  where h.book_id = new.book_id and h.edition = new.edition
    and h.status = 'held'
    and (tg_table_name <> 'author_preorder_volume_holds'
      or h.order_id <> new.order_id or h.book_id <> new.book_id);

  if new.edition = 'standard' then
    v_enabled := v_book.standard_enabled;
    v_reserved := v_book.standard_reserved;
    v_quota := v_book.standard_quota;
  else
    v_enabled := v_book.limited_enabled;
    v_reserved := v_book.limited_reserved;
    v_quota := v_book.limited_quota;
  end if;

  if v_enabled is distinct from true
     or v_reserved + v_legacy_held + v_multi_held + new.quantity::bigint > v_quota then
    raise exception 'PRE_ORDER_CROSS_FORMAT_STOCK_EXCEEDED';
  end if;

  return new;
end;
$$;

revoke all on function public.author_preorder_cross_format_stock_guard()
  from public, anon, authenticated;

drop trigger if exists author_preorder_legacy_cross_format_guard_trg
  on public.author_preorder_stock_holds;

create trigger author_preorder_legacy_cross_format_guard_trg
before insert or update of book_id, edition, quantity, status
on public.author_preorder_stock_holds
for each row execute function public.author_preorder_cross_format_stock_guard();

drop trigger if exists author_preorder_volume_cross_format_guard_trg
  on public.author_preorder_volume_holds;

create trigger author_preorder_volume_cross_format_guard_trg
before insert or update of book_id, edition, quantity, status
on public.author_preorder_volume_holds
for each row execute function public.author_preorder_cross_format_stock_guard();
