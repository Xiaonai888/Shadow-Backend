begin;

create table if not exists public.reader_restricted_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  restricted_user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint reader_restricted_accounts_distinct_users check (owner_user_id <> restricted_user_id),
  constraint reader_restricted_accounts_unique_pair unique (owner_user_id, restricted_user_id)
);

create index if not exists reader_restricted_accounts_owner_created_idx
  on public.reader_restricted_accounts (owner_user_id, created_at desc, id desc);

alter table public.reader_restricted_accounts enable row level security;

revoke all on public.reader_restricted_accounts from public, anon, authenticated;
grant select, insert, delete on public.reader_restricted_accounts to service_role;

create or replace function public.get_reader_restricted_page(
  p_owner uuid,
  p_query text,
  p_offset integer,
  p_limit integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select
      greatest(0, least(coalesce(p_offset, 0), 9990)) as offset_value,
      greatest(1, least(coalesce(p_limit, 10), 10)) as limit_value,
      left(btrim(coalesce(p_query, '')), 80) as search_value
  ),
  matching as (
    select
      u.id,
      coalesce(nullif(btrim(u.name), ''), nullif(btrim(u.username), ''), 'Reader') as name,
      coalesce(u.username, '') as username,
      u.avatar_url,
      r.created_at as restricted_at
    from public.reader_restricted_accounts r
    join public.users u on u.id = r.restricted_user_id
    cross join params p
    where r.owner_user_id = p_owner
      and (
        p.search_value = ''
        or coalesce(u.name, '') ilike '%' || p.search_value || '%'
        or coalesce(u.username, '') ilike '%' || p.search_value || '%'
      )
  ),
  page_rows as (
    select m.id, m.name, m.username, m.avatar_url, m.restricted_at
    from matching m
    order by m.restricted_at desc, m.id desc
    offset (select offset_value from params)
    limit (select limit_value from params)
  ),
  total_rows as (
    select count(*)::integer as total from matching
  )
  select jsonb_build_object(
    'results', coalesce(
      (select jsonb_agg(to_jsonb(p) order by p.restricted_at desc, p.id desc) from page_rows p),
      '[]'::jsonb
    ),
    'total', (select total from total_rows),
    'has_more', (select total from total_rows) >
      ((select offset_value from params) + (select count(*) from page_rows))
  );
$$;

revoke all on function public.get_reader_restricted_page(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.get_reader_restricted_page(uuid, text, integer, integer) to service_role;

commit;
