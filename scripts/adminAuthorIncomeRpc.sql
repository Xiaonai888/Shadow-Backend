create or replace function public.get_admin_author_income_v1(
  p_page integer default 1,
  p_limit integer default 20,
  p_search text default '',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_share_source text default '',
  p_status text default 'all',
  p_sort text default 'author_earned_desc'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_search text := lower(left(trim(coalesce(p_search, '')), 80));
  v_share_source text := lower(left(trim(coalesce(p_share_source, '')), 64));
  v_status text := lower(trim(coalesce(p_status, 'all')));
  v_sort text := lower(trim(coalesce(p_sort, 'author_earned_desc')));
  v_result jsonb;
begin
  if v_status not in ('all', 'pending', 'available', 'paid', 'unknown') then
    v_status := 'all';
  end if;

  if v_sort not in (
    'author_earned_desc',
    'paid_diamonds_desc',
    'platform_earned_desc',
    'transactions_desc',
    'latest_desc'
  ) then
    v_sort := 'author_earned_desc';
  end if;

  with base as (
    select
      ae.id,
      ae.author_id,
      coalesce(ae.author_user_id, ap.user_id) as author_user_id,
      coalesce(ap.page_name, u.name, 'Unknown Author') as author_name,
      coalesce(ap.page_username, u.username, '') as author_username,
      coalesce(ap.page_slug, '') as page_slug,
      ae.paid_diamonds,
      ae.net_paid_diamonds,
      ae.author_earned_diamonds,
      ae.platform_earned_diamonds,
      ae.author_net_payout_usd,
      ae.withholding_amount_usd,
      coalesce(ae.diamond_to_usd_rate, 0.01) as diamond_to_usd_rate,
      coalesce(ae.earning_status, 'unknown') as earning_status,
      coalesce(ae.share_source, '') as share_source,
      ae.created_at
    from public.author_earnings ae
    left join public.author_pages ap
      on ap.id = ae.author_id
    left join public.users u
      on u.id = coalesce(ae.author_user_id, ap.user_id)
    where ae.currency = 'diamond'
      and coalesce(ae.earning_status, 'unknown') <> 'void'
      and (p_from is null or ae.created_at >= p_from)
      and (p_to is null or ae.created_at < p_to)
      and (
        v_share_source = ''
        or lower(coalesce(ae.share_source, '')) = v_share_source
      )
      and (
        v_status = 'all'
        or lower(coalesce(ae.earning_status, 'unknown')) = v_status
      )
      and (
        v_search = ''
        or lower(
          concat_ws(
            ' ',
            ap.page_name,
            ap.page_username,
            ap.page_slug,
            u.name,
            u.username,
            u.email
          )
        ) like '%' || v_search || '%'
      )
  ),
  grouped as (
    select
      author_id as author_page_id,
      author_user_id,
      max(author_name) as author_name,
      max(author_username) as author_username,
      max(page_slug) as page_slug,
      round(coalesce(sum(paid_diamonds), 0)::numeric, 6) as paid_diamonds,
      round(coalesce(sum(net_paid_diamonds), 0)::numeric, 6) as net_paid_diamonds,
      round(coalesce(sum(author_earned_diamonds), 0)::numeric, 6) as author_earned_diamonds,
      round(coalesce(sum(platform_earned_diamonds), 0)::numeric, 6) as platform_earned_diamonds,
      round(
        coalesce(
          sum(author_earned_diamonds * diamond_to_usd_rate),
          0
        )::numeric,
        2
      ) as author_earnings_usd,
      round(
        coalesce(
          sum(platform_earned_diamonds * diamond_to_usd_rate),
          0
        )::numeric,
        2
      ) as platform_income_usd,
      round(coalesce(sum(author_net_payout_usd), 0)::numeric, 2) as author_net_payout_usd,
      round(coalesce(sum(withholding_amount_usd), 0)::numeric, 2) as withholding_usd,
      round(
        coalesce(
          sum(
            case
              when earning_status in ('pending', 'available')
                then author_net_payout_usd
              else 0
            end
          ),
          0
        )::numeric,
        2
      ) as pending_payout_usd,
      round(
        coalesce(
          sum(
            case
              when earning_status = 'paid'
                then author_net_payout_usd
              else 0
            end
          ),
          0
        )::numeric,
        2
      ) as paid_payout_usd,
      count(*)::integer as transaction_count,
      count(*) filter (
        where earning_status in ('pending', 'available')
      )::integer as pending_transaction_count,
      count(*) filter (
        where earning_status = 'paid'
      )::integer as paid_transaction_count,
      max(created_at) as latest_income_at
    from base
    group by author_id, author_user_id
  ),
  summary as (
    select
      round(coalesce(sum(b.paid_diamonds), 0)::numeric, 6) as paid_diamonds,
      round(coalesce(sum(b.net_paid_diamonds), 0)::numeric, 6) as net_paid_diamonds,
      round(coalesce(sum(b.author_earned_diamonds), 0)::numeric, 6) as author_earned_diamonds,
      round(coalesce(sum(b.platform_earned_diamonds), 0)::numeric, 6) as platform_earned_diamonds,
      round(
        coalesce(
          sum(b.author_earned_diamonds * b.diamond_to_usd_rate),
          0
        )::numeric,
        2
      ) as author_earnings_usd,
      round(
        coalesce(
          sum(b.platform_earned_diamonds * b.diamond_to_usd_rate),
          0
        )::numeric,
        2
      ) as platform_income_usd,
      round(coalesce(sum(b.author_net_payout_usd), 0)::numeric, 2) as author_net_payout_usd,
      round(coalesce(sum(b.withholding_amount_usd), 0)::numeric, 2) as withholding_usd,
      round(
        coalesce(
          sum(
            case
              when b.earning_status in ('pending', 'available')
                then b.author_net_payout_usd
              else 0
            end
          ),
          0
        )::numeric,
        2
      ) as pending_payout_usd,
      round(
        coalesce(
          sum(
            case
              when b.earning_status = 'paid'
                then b.author_net_payout_usd
              else 0
            end
          ),
          0
        )::numeric,
        2
      ) as paid_payout_usd,
      count(b.id)::integer as transaction_count,
      (select count(*)::integer from grouped) as author_count,
      round(
        (
          coalesce(sum(b.net_paid_diamonds), 0)
          - coalesce(sum(b.author_earned_diamonds), 0)
          - coalesce(sum(b.platform_earned_diamonds), 0)
        )::numeric,
        6
      ) as reconciliation_difference_diamonds
    from base b
  ),
  ordered as (
    select
      grouped.*,
      case
        when pending_transaction_count > 0 and paid_transaction_count > 0 then 'mixed'
        when pending_transaction_count > 0 then 'pending'
        when paid_transaction_count > 0 then 'paid'
        else 'unknown'
      end as payout_status
    from grouped
    order by
      case when v_sort = 'author_earned_desc' then author_earned_diamonds end desc nulls last,
      case when v_sort = 'paid_diamonds_desc' then paid_diamonds end desc nulls last,
      case when v_sort = 'platform_earned_desc' then platform_earned_diamonds end desc nulls last,
      case when v_sort = 'transactions_desc' then transaction_count end desc nulls last,
      case when v_sort = 'latest_desc' then latest_income_at end desc nulls last,
      latest_income_at desc nulls last,
      coalesce(author_page_id::text, author_user_id::text, '') asc
    offset (v_page - 1) * v_limit
    limit v_limit
  ),
  items_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'author_page_id', author_page_id,
          'author_user_id', author_user_id,
          'author_name', author_name,
          'author_username', author_username,
          'page_slug', page_slug,
          'paid_diamonds', paid_diamonds,
          'net_paid_diamonds', net_paid_diamonds,
          'author_earned_diamonds', author_earned_diamonds,
          'platform_earned_diamonds', platform_earned_diamonds,
          'author_earnings_usd', author_earnings_usd,
          'platform_income_usd', platform_income_usd,
          'author_net_payout_usd', author_net_payout_usd,
          'withholding_usd', withholding_usd,
          'pending_payout_usd', pending_payout_usd,
          'paid_payout_usd', paid_payout_usd,
          'transaction_count', transaction_count,
          'pending_transaction_count', pending_transaction_count,
          'paid_transaction_count', paid_transaction_count,
          'latest_income_at', latest_income_at,
          'payout_status', payout_status
        )
      ),
      '[]'::jsonb
    ) as items
    from ordered
  )
  select jsonb_build_object(
    'ok', true,
    'source', 'author_earnings',
    'summary', jsonb_build_object(
      'paid_diamonds', s.paid_diamonds,
      'net_paid_diamonds', s.net_paid_diamonds,
      'author_earned_diamonds', s.author_earned_diamonds,
      'platform_earned_diamonds', s.platform_earned_diamonds,
      'author_earnings_usd', s.author_earnings_usd,
      'platform_income_usd', s.platform_income_usd,
      'author_net_payout_usd', s.author_net_payout_usd,
      'withholding_usd', s.withholding_usd,
      'pending_payout_usd', s.pending_payout_usd,
      'paid_payout_usd', s.paid_payout_usd,
      'transaction_count', s.transaction_count,
      'author_count', s.author_count,
      'reconciliation_difference_diamonds', s.reconciliation_difference_diamonds
    ),
    'items', i.items,
    'pagination', jsonb_build_object(
      'page', v_page,
      'limit', v_limit,
      'total', s.author_count,
      'total_pages', case
        when s.author_count = 0 then 0
        else ceil(s.author_count::numeric / v_limit)::integer
      end,
      'has_prev', v_page > 1,
      'has_next', v_page * v_limit < s.author_count
    ),
    'filters', jsonb_build_object(
      'q', v_search,
      'share_source', v_share_source,
      'status', v_status,
      'sort', v_sort,
      'from', p_from,
      'to', p_to
    )
  )
  into v_result
  from summary s
  cross join items_json i;

  return coalesce(
    v_result,
    jsonb_build_object(
      'ok', true,
      'source', 'author_earnings',
      'summary', jsonb_build_object(
        'paid_diamonds', 0,
        'net_paid_diamonds', 0,
        'author_earned_diamonds', 0,
        'platform_earned_diamonds', 0,
        'author_earnings_usd', 0,
        'platform_income_usd', 0,
        'author_net_payout_usd', 0,
        'withholding_usd', 0,
        'pending_payout_usd', 0,
        'paid_payout_usd', 0,
        'transaction_count', 0,
        'author_count', 0,
        'reconciliation_difference_diamonds', 0
      ),
      'items', '[]'::jsonb,
      'pagination', jsonb_build_object(
        'page', v_page,
        'limit', v_limit,
        'total', 0,
        'total_pages', 0,
        'has_prev', false,
        'has_next', false
      )
    )
  );
end;
$$;

revoke all on function public.get_admin_author_income_v1(
  integer,
  integer,
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text
) from public;

grant execute on function public.get_admin_author_income_v1(
  integer,
  integer,
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text
) to service_role;
