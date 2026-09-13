create index if not exists idx_author_earnings_recent_author_created
on public.author_earnings (author_id, created_at desc)
where currency = 'diamond'
  and source_type = 'diamond_unlock'
  and earning_status <> 'void';

create or replace function public.get_author_recent_earnings_v1(
  p_user_id uuid,
  p_start timestamptz,
  p_end timestamptz,
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

  if p_start is null or p_end is null or p_start >= p_end then
    raise exception 'Invalid recent earnings date range';
  end if;

  if p_end - p_start > interval '30 days' then
    raise exception 'Recent earnings date range cannot exceed 30 days';
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
        'total_transactions', 0,
        'total_paid_diamonds', 0,
        'total_author_diamonds', 0,
        'total_author_usd', 0
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

  with filtered as (
    select
      ae.id,
      ae.reader_id,
      ae.story_id,
      ae.episode_id,
      ae.paid_diamonds,
      ae.author_earned_diamonds,
      ae.author_net_payout_usd,
      ae.author_share_percent,
      ae.earning_status,
      ae.metadata,
      ae.created_at
    from public.author_earnings ae
    where ae.author_id = v_author_id
      and ae.currency = 'diamond'
      and ae.source_type = 'diamond_unlock'
      and ae.earning_status <> 'void'
      and ae.created_at >= p_start
      and ae.created_at < p_end
  ),
  totals as (
    select
      count(*)::integer as total_transactions,
      coalesce(sum(paid_diamonds), 0)::numeric as total_paid_diamonds,
      coalesce(sum(author_earned_diamonds), 0)::numeric as total_author_diamonds,
      round(coalesce(sum(author_net_payout_usd), 0)::numeric, 2) as total_author_usd
    from filtered
  ),
  page_rows as (
    select
      f.id,
      f.reader_id,
      coalesce(
        u.name,
        u.username,
        f.metadata->>'reader_name',
        f.metadata->>'reader_username',
        'Reader'
      ) as reader_name,
      coalesce(
        u.username,
        f.metadata->>'reader_username',
        ''
      ) as reader_username,
      coalesce(
        u.avatar_url,
        f.metadata->>'reader_avatar_url',
        ''
      ) as reader_avatar_url,
      f.story_id,
      coalesce(
        s.title,
        f.metadata->>'story_title',
        'Story'
      ) as story_title,
      f.episode_id,
      coalesce(
        e.title,
        f.metadata->>'episode_title',
        'Episode unlock'
      ) as episode_title,
      coalesce(
        e.episode_number,
        case
          when coalesce(f.metadata->>'episode_number', '') ~ '^\d+$'
            then (f.metadata->>'episode_number')::integer
          else 0
        end,
        0
      ) as episode_number,
      coalesce(f.paid_diamonds, 0) as paid_diamonds,
      coalesce(f.author_earned_diamonds, 0) as author_earned_diamonds,
      round(coalesce(f.author_net_payout_usd, 0)::numeric, 2) as author_net_payout_usd,
      coalesce(f.author_share_percent, 0) as author_share_percent,
      coalesce(f.earning_status, 'available') as earning_status,
      f.created_at
    from filtered f
    left join public.users u
      on u.id = f.reader_id
    left join public.stories s
      on s.id = f.story_id
    left join public.episodes e
      on e.id = f.episode_id
    order by f.created_at desc, f.id desc
    offset v_offset
    limit v_limit
  ),
  page_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'reader_id', reader_id,
          'reader_name', reader_name,
          'reader_username', reader_username,
          'reader_avatar_url', reader_avatar_url,
          'story_id', story_id,
          'story_title', story_title,
          'episode_id', episode_id,
          'episode_title', episode_title,
          'episode_number', episode_number,
          'paid_diamonds', paid_diamonds,
          'author_earned_diamonds', author_earned_diamonds,
          'author_net_payout_usd', author_net_payout_usd,
          'author_share_percent', author_share_percent,
          'earning_status', earning_status,
          'created_at', created_at
        )
        order by created_at desc, id desc
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
      'total_transactions', t.total_transactions,
      'total_paid_diamonds', t.total_paid_diamonds,
      'total_author_diamonds', t.total_author_diamonds,
      'total_author_usd', t.total_author_usd
    ),
    'items', p.items,
    'pagination', jsonb_build_object(
      'page', v_page,
      'limit', v_limit,
      'total', t.total_transactions,
      'total_pages', case
        when t.total_transactions = 0 then 0
        else ceil(t.total_transactions::numeric / v_limit)::integer
      end,
      'has_prev', v_page > 1,
      'has_next', v_page * v_limit < t.total_transactions
    )
  )
  into v_result
  from totals t
  cross join page_json p;

  return v_result;
end;
$$;

revoke all on function public.get_author_recent_earnings_v1(
  uuid,
  timestamptz,
  timestamptz,
  integer,
  integer
) from public;

grant execute on function public.get_author_recent_earnings_v1(
  uuid,
  timestamptz,
  timestamptz,
  integer,
  integer
) to service_role;
