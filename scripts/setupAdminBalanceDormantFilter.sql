create or replace function public.get_admin_balance_wallets_v2(
  p_page integer default 1,
  p_limit integer default 20,
  p_search text default '',
  p_sort text default 'desc',
  p_dormant_only boolean default false,
  p_dormant_days integer default 90
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
  v_dormant_days integer := greatest(1, least(coalesce(p_dormant_days, 90), 3650));
  v_offset integer;
  v_items jsonb := '[]'::jsonb;
  v_has_next boolean := false;
begin
  v_offset := (v_page - 1) * v_limit;

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
      (
        v_search = ''
        or lower(u.username) like v_search || '%'
        or lower(u.name) like v_search || '%'
      )
      and (
        not coalesce(p_dormant_only, false)
        or (
          coalesce(w.diamond_balance, 0) > 0
          and not exists (
            select 1
            from public.episode_unlock_transactions t
            where t.user_id = w.user_id
              and t.currency = 'diamond'
              and t.transaction_type = 'unlock'
              and coalesce(t.amount, 0) > 0
              and t.created_at >= now() - make_interval(days => v_dormant_days)
          )
          and not exists (
            select 1
            from public.author_earnings g
            where g.reader_id = w.user_id
              and g.currency = 'diamond'
              and g.source_type = 'diamond_gift'
              and coalesce(g.earning_status, '') <> 'void'
              and coalesce(g.paid_diamonds, 0) > 0
              and g.created_at >= now() - make_interval(days => v_dormant_days)
          )
        )
      )
    order by
      case when v_sort = 'asc' then coalesce(w.diamond_balance, 0) end asc,
      case when v_sort = 'desc' then coalesce(w.diamond_balance, 0) end desc,
      case when v_sort = 'asc' then w.user_id end asc,
      case when v_sort = 'desc' then w.user_id end desc
    limit v_limit + 1
    offset v_offset
  ),
  page_rows as (
    select *
    from ranked
    limit v_limit
  ),
  enriched as (
    select
      p.*,
      spend.last_diamond_spent_at,
      (
        p.diamond_balance > 0
        and (
          spend.last_diamond_spent_at is null
          or spend.last_diamond_spent_at <
            now() - make_interval(days => v_dormant_days)
        )
      ) as dormant_diamonds
    from page_rows p
    left join lateral (
      select max(source.created_at) as last_diamond_spent_at
      from (
        select max(t.created_at) as created_at
        from public.episode_unlock_transactions t
        where t.user_id = p.user_id
          and t.currency = 'diamond'
          and t.transaction_type = 'unlock'
          and coalesce(t.amount, 0) > 0

        union all

        select max(g.created_at) as created_at
        from public.author_earnings g
        where g.reader_id = p.user_id
          and g.currency = 'diamond'
          and g.source_type = 'diamond_gift'
          and coalesce(g.earning_status, '') <> 'void'
          and coalesce(g.paid_diamonds, 0) > 0
      ) source
    ) spend on true
  )
  select
    coalesce(
      jsonb_agg(
        to_jsonb(e)
        order by
          case when v_sort = 'asc' then e.diamond_balance end asc,
          case when v_sort = 'desc' then e.diamond_balance end desc,
          case when v_sort = 'asc' then e.user_id end asc,
          case when v_sort = 'desc' then e.user_id end desc
      ),
      '[]'::jsonb
    ),
    (select count(*) > v_limit from ranked)
  into v_items, v_has_next
  from enriched e;

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
    'search', v_search,
    'filters', jsonb_build_object(
      'dormant_only', coalesce(p_dormant_only, false),
      'dormant_days', v_dormant_days
    )
  );
end;
$$;

revoke all on function public.get_admin_balance_wallets_v2(
  integer,
  integer,
  text,
  text,
  boolean,
  integer
) from public;

grant execute on function public.get_admin_balance_wallets_v2(
  integer,
  integer,
  text,
  text,
  boolean,
  integer
) to service_role;
