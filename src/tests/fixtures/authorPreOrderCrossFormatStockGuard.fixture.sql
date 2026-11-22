do $$
begin
  if current_database() <> 'preorder_guard_ci' then
    raise exception 'PRE_ORDER_CI_DATABASE_REQUIRED';
  end if;
  if to_regclass('public.author_preorder_books') is not null
     or to_regclass('public.author_preorder_stock_holds') is not null
     or to_regclass('public.author_preorder_volume_holds') is not null then
    raise exception 'PRE_ORDER_CI_DATABASE_NOT_EMPTY';
  end if;
end;
$$;

create table public.author_preorder_books (
  id uuid primary key,
  standard_enabled boolean not null,
  standard_quota integer not null,
  standard_reserved integer not null,
  limited_enabled boolean not null,
  limited_quota integer not null,
  limited_reserved integer not null,
  constraint preorder_ci_book_standard_bounds check (
    standard_reserved between 0 and standard_quota
  ),
  constraint preorder_ci_book_limited_bounds check (
    limited_reserved between 0 and limited_quota
  )
);

create table public.author_preorder_stock_holds (
  order_id uuid primary key,
  book_id uuid not null references public.author_preorder_books(id),
  edition text not null check (edition in ('standard', 'limited')),
  quantity integer not null check (quantity between 1 and 99),
  status text not null default 'held' check (status in ('held', 'consumed', 'released'))
);

create table public.author_preorder_volume_holds (
  order_id uuid not null,
  book_id uuid not null references public.author_preorder_books(id),
  edition text not null check (edition in ('standard', 'limited')),
  quantity integer not null check (quantity between 1 and 99),
  status text not null default 'held' check (status in ('held', 'consumed', 'released')),
  primary key (order_id, book_id)
);
