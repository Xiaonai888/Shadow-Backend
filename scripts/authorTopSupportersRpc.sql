create index if not exists idx_author_earnings_top_supporters_month
on public.author_earnings (author_id, earning_month, reader_id)
include (
  paid_diamonds,
  author_earned_diamonds,
  author_net_payout_usd,
  created_at
)
where currency = 'diamond'
  and source_type = 'diamond_unlock'
  and earning_status <> 'void'
  and reader_id is not null;

create or replace function public.get_author_top_supporters_v1(
  p_user_id uuid,
  p_month text,
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

  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid month';
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
      'month', p_month,
      'source', 'author_earnings',
      'summary', jsonb_build_object(
        'total_supporters', 0,
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
      ae.reader_id,
      coalesce(sum(ae.paid_diamonds), 0)::numeric as total_paid_diamonds,
      coalesce(sum(ae.author_earned_diamonds), 0)::numeric as total_author_diamonds,
      round(coalesce(sum(ae.author_net_payout_usd), 0)::numeric, 2) as total_author_usd,
      count(*)::integer as unlock_count,
      max(ae.created_at) as latest_support_at
    from public.author_earnings ae
    where ae.author_id = v_author_id
      and ae.currency = 'diamond'
      and ae.source_type = 'diamond_unlock'
      and ae.earning_status <> 'void'
      and ae.earning_month = p_month
      and ae.reader_id is not null
    group by ae.reader_id
  ),
  ranked as (
    select
      row_number() over (
        order by total_paid_diamonds desc, latest_support_at desc, reader_id
      )::integer as rank,
      grouped.*
    from grouped
  ),
  totals as (
    select
      count(*)::integer as total_supporters,
      coalesce(sum(total_paid_diamonds), 0)::numeric as total_paid_diamonds,
      coalesce(sum(total_author_diamonds), 0)::numeric as total_author_diamonds,
      round(coalesce(sum(total_author_usd), 0)::numeric, 2) as total_author_usd,
      coalesce(sum(unlock_count), 0)::integer as total_unlocks
    from grouped
  ),
  page_rows as (
    select
      r.rank,
      r.reader_id,
      coalesce(u.name, u.username, 'Reader') as reader_name,
      coalesce(u.username, '') as reader_username,
      coalesce(u.avatar_url, '') as reader_avatar_url,
      r.total_paid_diamonds,
      r.total_author_diamonds,
      r.total_author_usd,
      r.unlock_count,
      r.latest_support_at
    from ranked r
    left join public.users u on u.id = r.reader_id
    order by r.rank
    offset v_offset
    limit v_limit
  ),
  page_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'rank', rank,
          'reader_id', reader_id,
          'reader_name', reader_name,
          'reader_username', reader_username,
          'reader_avatar_url', reader_avatar_url,
          'total_diamonds', total_paid_diamonds,
          'total_paid_diamonds', total_paid_diamonds,
          'total_author_diamonds', total_author_diamonds,
          'total_usd', total_author_usd,
          'total_author_usd', total_author_usd,
          'unlock_count', unlock_count,
          'latest_support_at', latest_support_at
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
    'month', p_month,
    'source', 'author_earnings',
    'summary', jsonb_build_object(
      'total_supporters', t.total_supporters,
      'total_paid_diamonds', t.total_paid_diamonds,
      'total_author_diamonds', t.total_author_diamonds,
      'total_author_usd', t.total_author_usd,
      'total_unlocks', t.total_unlocks
    ),
    'items', p.items,
    'pagination', jsonb_build_object(
      'page', v_page,
      'limit', v_limit,
      'total', t.total_supporters,
      'total_pages', case
        when t.total_supporters = 0 then 0
        else ceil(t.total_supporters::numeric / v_limit)::integer
      end,
      'has_prev', v_page > 1,
      'has_next', v_page * v_limit < t.total_supporters
    )
  )
  into v_result
  from totals t
  cross join page_json p;

  return v_result;
end;
$$;

revoke all on function public.get_author_top_supporters_v1(
  uuid,
  text,
  integer,
  integer
) from public;

grant execute on function public.get_author_top_supporters_v1(
  uuid,
  text,
  integer,
  integer
) to service_role;
