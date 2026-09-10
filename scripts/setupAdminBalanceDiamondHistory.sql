create index if not exists payment_transactions_admin_balance_history_idx
  on public.payment_transactions (user_id, created_at desc, id desc)
  where diamonds > 0;

create index if not exists episode_unlock_transactions_admin_diamond_history_idx
  on public.episode_unlock_transactions (user_id, created_at desc, id desc)
  where currency = 'diamond'
    and transaction_type = 'unlock';

create index if not exists author_earnings_admin_reader_diamond_gift_history_idx
  on public.author_earnings (reader_id, created_at desc, id desc)
  where currency = 'diamond'
    and source_type = 'diamond_gift';

create index if not exists reader_reward_history_admin_diamond_history_idx
  on public.reader_reward_history (user_id, created_at desc, id desc)
  where amount_diamonds <> 0;

create or replace function public.get_admin_balance_diamond_history_v1(
  p_user_id uuid,
  p_limit integer default 20,
  p_before_created_at timestamptz default null,
  p_before_event_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
  v_items jsonb := '[]'::jsonb;
  v_has_next boolean := false;
  v_next_created_at timestamptz := null;
  v_next_event_key text := null;
begin
  if p_user_id is null then
    raise exception 'User ID is required';
  end if;

  with all_events as (
    select
      'purchase:' || p.id::text as event_key,
      coalesce(p.released_at, p.paid_at, p.created_at) as created_at,
      'purchase'::text as event_type,
      'credit'::text as direction,
      abs(coalesce(p.diamonds, 0))::numeric as amount_diamonds,
      'Diamond Purchase'::text as title,
      coalesce(nullif(p.payment_method, ''), 'Payment')::text as detail,
      p.id::text as reference_id,
      coalesce(p.order_id, '')::text as order_id,
      coalesce(p.amount_usd, p.package_usd, 0)::numeric as amount_usd,
      null::text as story_id,
      null::text as story_title,
      null::text as episode_id,
      null::integer as episode_number,
      null::text as episode_title,
      null::text as author_id,
      null::text as author_name
    from public.payment_transactions p
    where p.user_id = p_user_id
      and coalesce(p.diamonds, 0) > 0
      and (
        p.released_at is not null
        or lower(coalesce(p.status, '')) in ('success', 'approved', 'confirmed')
      )

    union all

    select
      'unlock:' || t.id::text as event_key,
      t.created_at,
      'episode_unlock'::text as event_type,
      'debit'::text as direction,
      abs(coalesce(t.amount, 0))::numeric as amount_diamonds,
      'Episode Unlock'::text as title,
      coalesce(nullif(s.title, ''), 'Story')::text as detail,
      t.id::text as reference_id,
      ''::text as order_id,
      0::numeric as amount_usd,
      t.story_id::text as story_id,
      coalesce(s.title, '')::text as story_title,
      t.episode_id::text as episode_id,
      coalesce(e.episode_number, 0)::integer as episode_number,
      coalesce(e.title, '')::text as episode_title,
      t.author_id::text as author_id,
      coalesce(a.page_name, '')::text as author_name
    from public.episode_unlock_transactions t
    left join public.stories s
      on s.id = t.story_id
    left join public.episodes e
      on e.id = t.episode_id
    left join public.author_pages a
      on a.id = t.author_id
    where t.user_id = p_user_id
      and t.currency = 'diamond'
      and t.transaction_type = 'unlock'
      and coalesce(t.amount, 0) > 0

    union all

    select
      'gift:' || g.id::text as event_key,
      g.created_at,
      'diamond_gift'::text as event_type,
      'debit'::text as direction,
      abs(coalesce(g.paid_diamonds, 0))::numeric as amount_diamonds,
      'Diamond Gift'::text as title,
      case
        when s.id is not null then coalesce(nullif(s.title, ''), 'Story')
        when a.id is not null then coalesce(nullif(a.page_name, ''), 'Author Page')
        else 'Gift'
      end::text as detail,
      g.id::text as reference_id,
      ''::text as order_id,
      0::numeric as amount_usd,
      g.story_id::text as story_id,
      coalesce(s.title, '')::text as story_title,
      null::text as episode_id,
      null::integer as episode_number,
      null::text as episode_title,
      g.author_id::text as author_id,
      coalesce(a.page_name, '')::text as author_name
    from public.author_earnings g
    left join public.stories s
      on s.id = g.story_id
    left join public.author_pages a
      on a.id = g.author_id
    where g.reader_id = p_user_id
      and g.currency = 'diamond'
      and g.source_type = 'diamond_gift'
      and coalesce(g.earning_status, '') <> 'void'
      and coalesce(g.paid_diamonds, 0) > 0

    union all

    select
      'reward:' || r.id::text as event_key,
      r.created_at,
      'reward'::text as event_type,
      case
        when coalesce(r.amount_diamonds, 0) >= 0 then 'credit'
        else 'debit'
      end::text as direction,
      abs(coalesce(r.amount_diamonds, 0))::numeric as amount_diamonds,
      coalesce(nullif(r.source_title, ''), 'Diamond Reward')::text as title,
      coalesce(nullif(r.source_key, ''), 'Reward')::text as detail,
      r.id::text as reference_id,
      ''::text as order_id,
      0::numeric as amount_usd,
      null::text as story_id,
      null::text as story_title,
      null::text as episode_id,
      null::integer as episode_number,
      null::text as episode_title,
      null::text as author_id,
      null::text as author_name
    from public.reader_reward_history r
    where r.user_id = p_user_id
      and coalesce(r.amount_diamonds, 0) <> 0
  ),
  filtered as (
    select *
    from all_events
    where
      p_before_created_at is null
      or created_at < p_before_created_at
      or (
        created_at = p_before_created_at
        and p_before_event_key is not null
        and event_key < p_before_event_key
      )
  ),
  limited as (
    select *
    from filtered
    order by created_at desc, event_key desc
    limit v_limit + 1
  ),
  page_rows as (
    select *
    from limited
    order by created_at desc, event_key desc
    limit v_limit
  )
  select
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(row_data)
          order by row_data.created_at desc, row_data.event_key desc
        )
        from page_rows row_data
      ),
      '[]'::jsonb
    ),
    (select count(*) > v_limit from limited),
    (
      select row_data.created_at
      from page_rows row_data
      order by row_data.created_at asc, row_data.event_key asc
      limit 1
    ),
    (
      select row_data.event_key
      from page_rows row_data
      order by row_data.created_at asc, row_data.event_key asc
      limit 1
    )
  into
    v_items,
    v_has_next,
    v_next_created_at,
    v_next_event_key;

  return jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'items', v_items,
    'pagination', jsonb_build_object(
      'limit', v_limit,
      'has_next', v_has_next,
      'next_cursor',
        case
          when v_has_next and v_next_created_at is not null then
            jsonb_build_object(
              'created_at', v_next_created_at,
              'event_key', v_next_event_key
            )
          else null
        end
    )
  );
end;
$$;

revoke all on function public.get_admin_balance_diamond_history_v1(
  uuid,
  integer,
  timestamptz,
  text
) from public;

grant execute on function public.get_admin_balance_diamond_history_v1(
  uuid,
  integer,
  timestamptz,
  text
) to service_role;
