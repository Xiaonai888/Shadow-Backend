create table if not exists public.author_preorder_volume_holds (
  order_id uuid not null references public.author_preorder_orders(id) on delete restrict,
  book_id uuid not null references public.author_preorder_books(id) on delete restrict,
  edition text not null,
  quantity integer not null,
  status text not null default 'held',
  held_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  released_at timestamptz,
  primary key (order_id, book_id),
  constraint author_preorder_volume_hold_edition_check check (edition in ('standard','limited')),
  constraint author_preorder_volume_hold_quantity_check check (quantity between 1 and 99),
  constraint author_preorder_volume_hold_status_check check (status in ('held','consumed','released')),
  constraint author_preorder_volume_hold_expiry_check check (expires_at > held_at),
  constraint author_preorder_volume_hold_state_check check (
    (status = 'held' and consumed_at is null and released_at is null)
    or (status = 'consumed' and consumed_at is not null and released_at is null)
    or (status = 'released' and consumed_at is null and released_at is not null)
  )
);

create index if not exists author_preorder_volume_holds_stock_idx
  on public.author_preorder_volume_holds (book_id, edition)
  where status = 'held';

create index if not exists author_preorder_volume_holds_expired_idx
  on public.author_preorder_volume_holds (expires_at, order_id)
  where status = 'held';

alter table public.author_preorder_volume_holds enable row level security;
revoke all on public.author_preorder_volume_holds from public, anon, authenticated;
grant select, insert, update on public.author_preorder_volume_holds to service_role;

create or replace function public.author_preorder_stock_snapshot_multivolume(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'book_id', b.id,
    'title', b.title,
    'standard', jsonb_build_object(
      'enabled', b.standard_enabled,
      'quota', b.standard_quota,
      'paid_reserved', b.standard_reserved,
      'payment_pending_held', h.standard_held,
      'available', case when b.standard_enabled then greatest(
        0::bigint, b.standard_quota::bigint - b.standard_reserved::bigint - h.standard_held
      ) else 0::bigint end
    ),
    'limited', jsonb_build_object(
      'enabled', b.limited_enabled,
      'quota', b.limited_quota,
      'paid_reserved', b.limited_reserved,
      'payment_pending_held', h.limited_held,
      'available', case when b.limited_enabled then greatest(
        0::bigint, b.limited_quota::bigint - b.limited_reserved::bigint - h.limited_held
      ) else 0::bigint end
    )
  ) order by b.position), '[]'::jsonb)
  from public.author_preorder_books b
  cross join lateral (
    select
      coalesce(sum(x.quantity) filter (where x.edition = 'standard'), 0)::bigint as standard_held,
      coalesce(sum(x.quantity) filter (where x.edition = 'limited'), 0)::bigint as limited_held
    from (
      select lh.edition, lh.quantity
      from public.author_preorder_stock_holds lh
      where lh.book_id = b.id and lh.status = 'held'
      union all
      select mh.edition, mh.quantity
      from public.author_preorder_volume_holds mh
      where mh.book_id = b.id and mh.status = 'held'
    ) x
  ) h
  where b.campaign_id = p_campaign_id;
$$;

revoke all on function public.author_preorder_stock_snapshot_multivolume(uuid)
  from public, anon, authenticated;
grant execute on function public.author_preorder_stock_snapshot_multivolume(uuid)
  to service_role;
