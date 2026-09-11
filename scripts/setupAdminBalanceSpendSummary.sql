create or replace function public.get_admin_balance_spend_summary_v1(
  p_user_id uuid,
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
  v_total_spent numeric := 0;
  v_unlock_spent numeric := 0;
  v_gift_spent numeric := 0;
  v_top_authors jsonb := '[]'::jsonb;
  v_top_stories jsonb := '[]'::jsonb;
begin
  if p_user_id is null then
    raise exception 'User ID is required';
  end if;

  with unlocks as (
    select coalesce(t.amount, 0)::numeric as diamonds
    from public.episode_unlock_transactions t
    where t.user_id = p_user_id
      and t.currency = 'diamond'
      and t.transaction_type = 'unlock'
      and coalesce(t.amount, 0) > 0
  ),
  gifts as (
    select coalesce(g.paid_diamonds, 0)::numeric as diamonds
    from public.author_earnings g
    where g.reader_id = p_user_id
      and g.currency = 'diamond'
      and g.source_type = 'diamond_gift'
      and coalesce(g.earning_status, '') <> 'void'
      and coalesce(g.paid_diamonds, 0) > 0
  )
  select
    coalesce((select sum(diamonds) from unlocks), 0),
    coalesce((select sum(diamonds) from gifts), 0)
  into v_unlock_spent, v_gift_spent;

  v_total_spent := v_unlock_spent + v_gift_spent;

  with author_spend as (
    select
      t.author_id,
      sum(coalesce(t.amount, 0))::numeric as unlock_diamonds,
      0::numeric as gift_diamonds
    from public.episode_unlock_transactions t
    where t.user_id = p_user_id
      and t.currency = 'diamond'
      and t.transaction_type = 'unlock'
      and coalesce(t.amount, 0) > 0
      and t.author_id is not null
    group by t.author_id

    union all

    select
      g.author_id,
      0::numeric as unlock_diamonds,
      sum(coalesce(g.paid_diamonds, 0))::numeric as gift_diamonds
    from public.author_earnings g
    where g.reader_id = p_user_id
      and g.currency = 'diamond'
      and g.source_type = 'diamond_gift'
      and coalesce(g.earning_status, '') <> 'void'
      and coalesce(g.paid_diamonds, 0) > 0
      and g.author_id is not null
    group by g.author_id
  ),
  combined as (
    select
      author_id,
      sum(unlock_diamonds)::numeric as unlock_diamonds,
      sum(gift_diamonds)::numeric as gift_diamonds,
      sum(unlock_diamonds + gift_diamonds)::numeric as total_diamonds
    from author_spend
    group by author_id
  ),
  ranked as (
    select
      c.author_id,
      coalesce(a.page_name, '')::text as author_name,
      coalesce(a.page_username, '')::text as author_username,
      c.unlock_diamonds,
      c.gift_diamonds,
      c.total_diamonds
    from combined c
    left join public.author_pages a
      on a.id = c.author_id
    order by c.total_diamonds desc, c.author_id asc
    limit v_limit
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'author_id', r.author_id,
        'author_name', r.author_name,
        'author_username', r.author_username,
        'unlock_diamonds', r.unlock_diamonds,
        'gift_diamonds', r.gift_diamonds,
        'total_diamonds', r.total_diamonds
      )
      order by r.total_diamonds desc, r.author_id asc
    ),
    '[]'::jsonb
  )
  into v_top_authors
  from ranked r;

  with story_spend as (
    select
      t.story_id,
      t.author_id,
      sum(coalesce(t.amount, 0))::numeric as unlock_diamonds,
      0::numeric as gift_diamonds
    from public.episode_unlock_transactions t
    where t.user_id = p_user_id
      and t.currency = 'diamond'
      and t.transaction_type = 'unlock'
      and coalesce(t.amount, 0) > 0
      and t.story_id is not null
    group by t.story_id, t.author_id

    union all

    select
      g.story_id,
      g.author_id,
      0::numeric as unlock_diamonds,
      sum(coalesce(g.paid_diamonds, 0))::numeric as gift_diamonds
    from public.author_earnings g
    where g.reader_id = p_user_id
      and g.currency = 'diamond'
      and g.source_type = 'diamond_gift'
      and coalesce(g.earning_status, '') <> 'void'
      and coalesce(g.paid_diamonds, 0) > 0
      and g.story_id is not null
    group by g.story_id, g.author_id
  ),
  combined as (
    select
      story_id,
      max(author_id) as author_id,
      sum(unlock_diamonds)::numeric as unlock_diamonds,
      sum(gift_diamonds)::numeric as gift_diamonds,
      sum(unlock_diamonds + gift_diamonds)::numeric as total_diamonds
    from story_spend
    group by story_id
  ),
  ranked as (
    select
      c.story_id,
      coalesce(s.title, '')::text as story_title,
      c.author_id,
      coalesce(a.page_name, '')::text as author_name,
      c.unlock_diamonds,
      c.gift_diamonds,
      c.total_diamonds
    from combined c
    left join public.stories s
      on s.id = c.story_id
    left join public.author_pages a
      on a.id = c.author_id
    order by c.total_diamonds desc, c.story_id asc
    limit v_limit
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'story_id', r.story_id,
        'story_title', r.story_title,
        'author_id', r.author_id,
        'author_name', r.author_name,
        'unlock_diamonds', r.unlock_diamonds,
        'gift_diamonds', r.gift_diamonds,
        'total_diamonds', r.total_diamonds
      )
      order by r.total_diamonds desc, r.story_id asc
    ),
    '[]'::jsonb
  )
  into v_top_stories
  from ranked r;

  return jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'summary', jsonb_build_object(
      'total_spent_diamonds', v_total_spent,
      'episode_unlock_diamonds', v_unlock_spent,
      'diamond_gift_diamonds', v_gift_spent
    ),
    'top_authors', v_top_authors,
    'top_stories', v_top_stories,
    'limit', v_limit
  );
end;
$$;

revoke all on function public.get_admin_balance_spend_summary_v1(
  uuid,
  integer
) from public;

grant execute on function public.get_admin_balance_spend_summary_v1(
  uuid,
  integer
) to service_role;
