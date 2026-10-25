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
  if new.payment_status is distinct from 'paid' then
    return new;
  end if;

  if not exists (
    select 1 from public.author_store_book_payment_holds h
    where h.order_id = new.id and h.status <> 'refunded'
  ) then
    return new;
  end if;

  begin
    v_result := public.link_author_store_paid_book_to_chat(new.id);
    if coalesce((v_result ->> 'ok')::boolean, false) is distinct from true then
      raise warning 'BOOK_CHAT_AUTOLINK_UNEXPECTED_RESULT order=%', new.id;
    end if;
  exception when others then
    raise warning 'BOOK_CHAT_AUTOLINK_FAILED order=% sqlstate=%', new.id, sqlstate;
  end;

  return new;
end;
$$;

drop trigger if exists trg_zz_author_store_paid_book_chat_link on public.author_store_orders;

create trigger trg_zz_author_store_paid_book_chat_link
after insert or update of payment_status, author_income_usd, delivery_fee_usd
on public.author_store_orders
for each row
execute function public.autolink_verified_author_store_book_chat();

revoke all on function public.autolink_verified_author_store_book_chat()
from public, anon, authenticated;

grant execute on function public.autolink_verified_author_store_book_chat()
to service_role;

commit;
