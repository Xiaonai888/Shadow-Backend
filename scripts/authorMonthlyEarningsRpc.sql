create index if not exists idx_author_earnings_monthly_author_month
on public.author_earnings (author_id, earning_month desc)
include (
  paid_diamonds,
  author_earned_diamonds,
  author_net_payout_usd,
  reader_id,
  story_id,
  created_at
)
where currency = 'diamond'
  and source_type = 'diamond_unlock'
  and earning_status <> 'void'
  and earning_month is not null;

create or replace function public.get_author_monthly_earnings_v1(
  p_user_id uuid,
  p_page integer default 1,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author_id uuid;
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 10000);
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer;
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'Unauthorized';
  end if;

  select ap.id
  into v_author_id
  from public.author_pages ap
  where ap.user_id = p_user_id
  limit 1;

  if v_author_id is null then
    return jsonb_build_object(
      'ok', true,
      'has_author_page', false,
      'source', 'author_earnings',
      'summary', jsonb_build_object(
        'total_months', 0,
        'total_paid_diamonds', 0,
        'total_author_diamonds', 0,
        'total_author_usd', 0,
        'total_unlocks', 0
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
    );
  end if;

  v_offset := (v_page - 1) * v_limit;

  with grouped as (
    select
      ae.earning_month,
      coalesce(sum(ae.paid_diamonds), 0)::numeric as total_paid_diamonds,
      coalesce(sum(ae.author_earned_diamonds), 0)::numeric as total_author_diamonds,
      round(coalesce(sum(ae.author_net_payout_usd), 0)::numeric, 2) as total_author_usd,
      count(*)::integer as unlock_count,
      count(distinct ae.reader_id)::integer as supporter_count,
      count(distinct ae.story_id)::integer as story_count,
      max(ae.created_at) as latest_earning_at
    from public.author_earnings ae
    where ae.author_id = v_author_id
      and ae.currency = 'diamond'
      and ae.source_type = 'diamond_unlock'
      and ae.earning_status <> 'void'
      and ae.earning_month is not null
    group by ae.earning_month
  ),
  ranked as (
    select
      row_number() over (order by earning_month desc)::integer as rank,
      grouped.*
    from grouped
  ),
  totals as (
    select
      count(*)::integer as total_months,
      coalesce(sum(total_paid_diamonds), 0)::numeric as total_paid_diamonds,
      coalesce(sum(total_author_diamonds), 0)::numeric as total_author_diamonds,
      round(coalesce(sum(total_author_usd), 0)::numeric, 2) as total_author_usd,
      coalesce(sum(unlock_count), 0)::integer as total_unlocks
    from grouped
  ),
  page_rows as (
    select *
    from ranked
    order by rank
    offset v_offset
    limit v_limit
  ),
  page_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'rank', rank,
          'earning_month', earning_month,
          'total_paid_diamonds', total_paid_diamonds,
          'total_author_diamonds', total_author_diamonds,
          'total_author_usd', total_author_usd,
          'unlock_count', unlock_count,
          'supporter_count', supporter_count,
          'story_count', story_count,
          'latest_earning_at', latest_earning_at
        )
        order by rank
      ),
      '[]'::jsonb
    ) as items
    from page_rows
  )
  select jsonb_build_object(
    'ok', true,
    'has_author_page', true,
    'source', 'author_earnings',
    'summary', jsonb_build_object(
      'total_months', t.total_months,
      'total_paid_diamonds', t.total_paid_diamonds,
      'total_author_diamonds', t.total_author_diamonds,
      'total_author_usd', t.total_author_usd,
      'total_unlocks', t.total_unlocks
    ),
    'items', p.items,
    'pagination', jsonb_build_object(
      'page', v_page,
      'limit', v_limit,
      'total', t.total_months,
      'total_pages', case
        when t.total_months = 0 then 0
        else ceil(t.total_months::numeric / v_limit)::integer
      end,
      'has_prev', v_page > 1,
      'has_next', v_page * v_limit < t.total_months
    )
  )
  into v_result
  from totals t
  cross join page_json p;

  return v_result;
end;
$$;

revoke all on function public.get_author_monthly_earnings_v1(
  uuid,
  integer,
  integer
) from public;

grant execute on function public.get_author_monthly_earnings_v1(
  uuid,
  integer,
  integer
) to service_role;
