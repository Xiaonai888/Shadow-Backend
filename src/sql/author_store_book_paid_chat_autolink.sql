begin;

create or replace function public.autolink_verified_author_store_book_chat()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  if new.status = 'refunded' then
    return new;
  end if;

  begin
    if not exists (
      select 1
      from public.author_store_orders o
      join public.author_store_book_hold_activation a on a.id = 1
      where o.id = new.order_id
        and o.created_at >= a.activated_at
        and o.payment_status = 'paid'
        and o.buyer_id is not null
        and o.buyer_id = new.buyer_id
        and o.author_page_id = new.author_page_id
    ) then
      return new;
    end if;

    v_result := public.link_author_store_paid_book_to_chat(new.order_id);
    if coalesce(v_result ->> 'ok', 'false') <> 'true' then
      raise warning 'BOOK_CHAT_AUTOLINK_UNEXPECTED_RESULT order=%', new.order_id;
    end if;
  exception when others then
    raise warning 'BOOK_CHAT_AUTOLINK_FAILED order=% sqlstate=%', new.order_id, sqlstate;
  end;

  return new;
end;
$$;

drop trigger if exists trg_zz_author_store_paid_book_chat_link
on public.author_store_orders;

drop trigger if exists trg_author_store_book_chat_autolink_on_hold
on public.author_store_book_payment_holds;

create trigger trg_author_store_book_chat_autolink_on_hold
after insert on public.author_store_book_payment_holds
for each row
execute function public.autolink_verified_author_store_book_chat();

revoke all on function public.autolink_verified_author_store_book_chat()
from public, anon, authenticated;

grant execute on function public.autolink_verified_author_store_book_chat()
to service_role;

commit;
