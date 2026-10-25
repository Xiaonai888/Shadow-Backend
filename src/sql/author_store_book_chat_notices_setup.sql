begin;

create table if not exists public.author_store_book_chat_notices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.author_store_orders(id) on delete restrict,
  recipient_user_id uuid not null,
  notice_type text not null check (notice_type in (
    'payment_verified', 'book_shipped', 'reader_received', 'owner_released', 'refunded'
  )),
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (order_id, recipient_user_id, notice_type)
);

create index if not exists idx_author_store_book_chat_notices_recipient
on public.author_store_book_chat_notices (recipient_user_id, seen_at, created_at desc);

alter table public.author_store_book_chat_notices enable row level security;
revoke all on public.author_store_book_chat_notices from public, anon, authenticated;
grant select, insert, update on public.author_store_book_chat_notices to service_role;

create or replace function public.author_store_book_notice_on_chat_link()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_reader_id uuid;
  v_author_id uuid;
begin
  select o.buyer_id, p.user_id
  into v_reader_id, v_author_id
  from public.author_store_orders o
  join public.author_pages p on p.id = o.author_page_id
  where o.id = new.order_id and o.payment_status = 'paid';

  if v_reader_id is null or v_author_id is null then
    return new;
  end if;

  insert into public.author_store_book_chat_notices (
    order_id, recipient_user_id, notice_type
  ) values
    (new.order_id, v_reader_id, 'payment_verified'),
    (new.order_id, v_author_id, 'payment_verified')
  on conflict (order_id, recipient_user_id, notice_type) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_author_store_book_notice_paid on public.author_store_book_chat_links;

create trigger trg_author_store_book_notice_paid
after insert on public.author_store_book_chat_links
for each row
execute function public.author_store_book_notice_on_chat_link();

create or replace function public.author_store_book_notice_on_hold_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_author_id uuid;
  v_notice_type text;
begin
  if not exists (
    select 1 from public.author_store_book_chat_links l
    where l.order_id = new.order_id and l.hold_id = new.id
  ) then
    return new;
  end if;

  if new.status = 'under_review'
     and jsonb_array_length(new.proof_refs) > 0
     and (old.status is distinct from new.status
          or old.proof_refs is distinct from new.proof_refs) then
    v_notice_type := 'book_shipped';
  elsif new.status = 'released'
     and old.status is distinct from new.status
     and new.release_source = 'reader'
     and new.reader_confirmed_at is not null then
    v_notice_type := 'reader_received';
  elsif new.status = 'released'
     and old.status is distinct from new.status
     and new.release_source = 'admin' then
    v_notice_type := 'owner_released';
  elsif new.status = 'refunded'
     and old.status is distinct from new.status then
    v_notice_type := 'refunded';
  else
    return new;
  end if;

  if new.buyer_id is null then
    return new;
  end if;

  select p.user_id into v_author_id
  from public.author_pages p
  where p.id = new.author_page_id;

  if v_notice_type = 'book_shipped' then
    insert into public.author_store_book_chat_notices (
      order_id, recipient_user_id, notice_type
    ) values (new.order_id, new.buyer_id, v_notice_type)
    on conflict (order_id, recipient_user_id, notice_type) do nothing;
  elsif v_author_id is not null then
    insert into public.author_store_book_chat_notices (
      order_id, recipient_user_id, notice_type
    ) values
      (new.order_id, new.buyer_id, v_notice_type),
      (new.order_id, v_author_id, v_notice_type)
    on conflict (order_id, recipient_user_id, notice_type) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_author_store_book_notice_hold_change
on public.author_store_book_payment_holds;

create trigger trg_author_store_book_notice_hold_change
after update of status, proof_refs on public.author_store_book_payment_holds
for each row
execute function public.author_store_book_notice_on_hold_change();

revoke all on function public.author_store_book_notice_on_chat_link()
from public, anon, authenticated;
revoke all on function public.author_store_book_notice_on_hold_change()
from public, anon, authenticated;
grant execute on function public.author_store_book_notice_on_chat_link() to service_role;
grant execute on function public.author_store_book_notice_on_hold_change() to service_role;

commit;
