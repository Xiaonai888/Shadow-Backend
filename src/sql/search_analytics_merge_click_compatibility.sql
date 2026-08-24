create or replace function public.merge_search_analytics_groups(
  p_source_group_id bigint,
  p_target_group_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_source_status text;
  v_target_status text;
  v_target_name text;
begin
  if p_source_group_id is null
    or p_target_group_id is null
    or p_source_group_id <= 0
    or p_target_group_id <= 0 then
    raise exception 'Source and target group ids are required';
  end if;

  if p_source_group_id = p_target_group_id then
    raise exception 'Source and target cannot be the same group';
  end if;

  select status
  into v_source_status
  from public.search_term_groups
  where id = p_source_group_id
  for update;

  if not found then
    raise exception 'Source search group not found';
  end if;

  select status, canonical_term
  into v_target_status, v_target_name
  from public.search_term_groups
  where id = p_target_group_id
  for update;

  if not found then
    raise exception 'Target search group not found';
  end if;

  if v_source_status = 'merged' then
    raise exception 'Source group is already merged';
  end if;

  if v_target_status <> 'active' then
    raise exception 'Target group must be active';
  end if;

  insert into public.search_analytics_daily (
    search_date,
    group_id,
    search_type,
    searches,
    unique_searchers,
    no_result_searches,
    clicks,
    result_count_total,
    created_at,
    updated_at
  )
  select
    search_date,
    p_target_group_id,
    search_type,
    searches,
    0,
    no_result_searches,
    clicks,
    result_count_total,
    created_at,
    v_now
  from public.search_analytics_daily
  where group_id = p_source_group_id
  on conflict (search_date, group_id, search_type)
  do update set
    searches =
      public.search_analytics_daily.searches +
      excluded.searches,
    no_result_searches =
      public.search_analytics_daily.no_result_searches +
      excluded.no_result_searches,
    clicks =
      public.search_analytics_daily.clicks +
      excluded.clicks,
    result_count_total =
      public.search_analytics_daily.result_count_total +
      excluded.result_count_total,
    updated_at = v_now;

  insert into public.search_term_variants_daily (
    search_date,
    group_id,
    search_type,
    normalized_term,
    display_term,
    searches,
    no_result_searches,
    last_seen_at
  )
  select
    search_date,
    p_target_group_id,
    search_type,
    normalized_term,
    display_term,
    searches,
    no_result_searches,
    last_seen_at
  from public.search_term_variants_daily
  where group_id = p_source_group_id
  on conflict (
    search_date,
    group_id,
    search_type,
    normalized_term
  )
  do update set
    display_term = excluded.display_term,
    searches =
      public.search_term_variants_daily.searches +
      excluded.searches,
    no_result_searches =
      public.search_term_variants_daily.no_result_searches +
      excluded.no_result_searches,
    last_seen_at = greatest(
      public.search_term_variants_daily.last_seen_at,
      excluded.last_seen_at
    );

  insert into public.search_analytics_unique_daily (
    search_date,
    group_id,
    search_type,
    searcher_hash,
    created_at
  )
  select
    search_date,
    p_target_group_id,
    search_type,
    searcher_hash,
    created_at
  from public.search_analytics_unique_daily
  where group_id = p_source_group_id
  on conflict do nothing;

  insert into public.search_analytics_recent_dedupe (
    group_id,
    search_type,
    searcher_hash,
    last_searched_at,
    expires_at
  )
  select
    p_target_group_id,
    search_type,
    searcher_hash,
    last_searched_at,
    expires_at
  from public.search_analytics_recent_dedupe
  where group_id = p_source_group_id
  on conflict (group_id, search_type, searcher_hash)
  do update set
    last_searched_at = greatest(
      public.search_analytics_recent_dedupe.last_searched_at,
      excluded.last_searched_at
    ),
    expires_at = greatest(
      public.search_analytics_recent_dedupe.expires_at,
      excluded.expires_at
    );

  insert into public.search_analytics_click_dedupe (
    group_id,
    search_type,
    searcher_hash,
    target_key,
    last_clicked_at,
    expires_at
  )
  select
    p_target_group_id,
    search_type,
    searcher_hash,
    target_key,
    last_clicked_at,
    expires_at
  from public.search_analytics_click_dedupe
  where group_id = p_source_group_id
  on conflict (
    group_id,
    search_type,
    searcher_hash,
    target_key
  )
  do update set
    last_clicked_at = greatest(
      public.search_analytics_click_dedupe.last_clicked_at,
      excluded.last_clicked_at
    ),
    expires_at = greatest(
      public.search_analytics_click_dedupe.expires_at,
      excluded.expires_at
    );

  update public.search_term_aliases
  set
    group_id = p_target_group_id,
    last_seen_at = greatest(last_seen_at, v_now)
  where group_id = p_source_group_id;

  delete from public.search_analytics_click_dedupe
  where group_id = p_source_group_id;

  delete from public.search_analytics_recent_dedupe
  where group_id = p_source_group_id;

  delete from public.search_analytics_unique_daily
  where group_id = p_source_group_id;

  delete from public.search_term_variants_daily
  where group_id = p_source_group_id;

  delete from public.search_analytics_daily
  where group_id = p_source_group_id;

  update public.search_analytics_daily d
  set
    unique_searchers = (
      select count(*)::integer
      from public.search_analytics_unique_daily u
      where u.group_id = p_target_group_id
        and u.search_date = d.search_date
        and u.search_type = d.search_type
    ),
    updated_at = v_now
  where d.group_id = p_target_group_id;

  update public.search_term_groups
  set
    status = 'merged',
    merged_into = p_target_group_id,
    updated_at = v_now
  where id = p_source_group_id;

  update public.search_term_groups
  set updated_at = v_now
  where id = p_target_group_id;

  return jsonb_build_object(
    'source_group_id', p_source_group_id,
    'target_group_id', p_target_group_id,
    'target_name', v_target_name,
    'merged', true
  );
end;
$$;

revoke all
on function public.merge_search_analytics_groups(bigint, bigint)
from public, anon, authenticated;

grant execute
on function public.merge_search_analytics_groups(bigint, bigint)
to service_role;
