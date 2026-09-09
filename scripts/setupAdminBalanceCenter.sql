create index if not exists user_wallets_admin_diamond_rank_idx
  on public.user_wallets (diamond_balance desc, user_id desc);

create index if not exists users_admin_balance_username_search_idx
  on public.users (lower(username) text_pattern_ops);

create index if not exists users_admin_balance_name_search_idx
  on public.users (lower(name) text_pattern_ops);

create or replace function public.get_admin_balance_wallets_v1(
  p_page integer default 1,
  p_limit integer default 20,
  p_search text default '',
  p_sort text default 'desc'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_page integer := greatest(1, least(coalesce(p_page, 1), 100000));
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
  v_search text := lower(ltrim(trim(coalesce(p_search, '')), '@'));
  v_sort text := case
    when lower(trim(coalesce(p_sort, 'desc'))) = 'asc' then 'asc'
    else 'desc'
  end;
  v_offset integer;
  v_items jsonb := '[]'::jsonb;
  v_has_next boolean := false;
begin
  v_offset := (v_page - 1) * v_limit;

  if v_sort = 'asc' then
    with ranked as (
      select
        u.id as user_id,
        u.name,
        u.username,
        u.avatar_url,
        coalesce(w.diamond_balance, 0) as diamond_balance,
        coalesce(w.gem_balance, 0) as coin_balance,
        coalesce(w.voucher_balance, 0) as voucher_balance,
        coalesce(w.story_card_balance, 0) as story_card_balance,
        w.updated_at as wallet_updated_at
      from public.user_wallets w
      join public.users u
        on u.id = w.user_id
      where
        v_search = ''
        or lower(u.username) like v_search || '%'
        or lower(u.name) like v_search || '%'
      order by
        w.diamond_balance asc,
        w.user_id asc
      limit (v_limit + 1)
      offset v_offset
    ),
    page_rows as (
      select *
      from ranked
      limit v_limit
    )
    select
      coalesce(
        jsonb_agg(
          to_jsonb(pr)
          order by pr.diamond_balance asc, pr.user_id asc
        ),
        '[]'::jsonb
      ),
      (select count(*) > v_limit from ranked)
    into v_items, v_has_next
    from page_rows pr;
  else
    with ranked as (
      select
        u.id as user_id,
        u.name,
        u.username,
        u.avatar_url,
        coalesce(w.diamond_balance, 0) as diamond_balance,
        coalesce(w.gem_balance, 0) as coin_balance,
        coalesce(w.voucher_balance, 0) as voucher_balance,
        coalesce(w.story_card_balance, 0) as story_card_balance,
        w.updated_at as wallet_updated_at
      from public.user_wallets w
      join public.users u
        on u.id = w.user_id
      where
        v_search = ''
        or lower(u.username) like v_search || '%'
        or lower(u.name) like v_search || '%'
      order by
        w.diamond_balance desc,
        w.user_id desc
      limit (v_limit + 1)
      offset v_offset
    ),
    page_rows as (
      select *
      from ranked
      limit v_limit
    )
    select
      coalesce(
        jsonb_agg(
          to_jsonb(pr)
          order by pr.diamond_balance desc, pr.user_id desc
        ),
        '[]'::jsonb
      ),
      (select count(*) > v_limit from ranked)
    into v_items, v_has_next
    from page_rows pr;
  end if;

  return jsonb_build_object(
    'ok', true,
    'items', v_items,
    'pagination', jsonb_build_object(
      'page', v_page,
      'limit', v_limit,
      'has_prev', v_page > 1,
      'has_next', v_has_next
    ),
    'sort', v_sort,
    'search', v_search
  );
end;
$$;

revoke all on function public.get_admin_balance_wallets_v1(integer, integer, text, text) from public;
grant execute on function public.get_admin_balance_wallets_v1(integer, integer, text, text) to service_role;
