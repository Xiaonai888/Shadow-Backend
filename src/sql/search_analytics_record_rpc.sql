create or replace function public.record_search_analytics_event(
  p_display_term text,
  p_normalized_term text,
  p_search_type text,
  p_searcher_hash text,
  p_result_count integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_today date := current_date;
  v_group_id bigint;
  v_redirect_group_id bigint;
  v_group_status text;
  v_counted_group_id bigint;
  v_unique_added integer := 0;
  v_no_result integer := 0;
  v_result_count integer := greatest(coalesce(p_result_count, 0), 0);
  v_display_term text := left(trim(coalesce(p_display_term, '')), 120);
  v_normalized_term text := left(lower(trim(coalesce(p_normalized_term, ''))), 120);
  v_search_type text := lower(trim(coalesce(p_search_type, 'all')));
begin
  if length(v_normalized_term) < 2 then
    return jsonb_build_object(
      'ok', true,
      'counted', false,
      'reason', 'term_too_short'
    );
  end if;

  if length(trim(coalesce(p_searcher_hash, ''))) < 16 then
    return jsonb_build_object(
      'ok', true,
      'counted', false,
      'reason', 'missing_searcher'
    );
  end if;

  if v_search_type not in (
    'all',
    'readers',
    'pages',
    'stories',
    'pdfs',
    'posts'
  ) then
    v_search_type := 'all';
  end if;

  select
    a.group_id
  into
    v_group_id
  from public.search_term_aliases a
  where a.normalized_alias = v_normalized_term
  limit 1;

  if v_group_id is null then
    insert into public.search_term_groups (
      canonical_term,
      normalized_term,
      status,
      created_at,
      updated_at
    )
    values (
      coalesce(nullif(v_display_term, ''), v_normalized_term),
      v_normalized_term,
      'active',
      v_now,
      v_now
    )
    on conflict (normalized_term)
    do update set
      updated_at = excluded.updated_at
    returning id
    into v_group_id;
  end if;

  select
    status,
    merged_into
  into
    v_group_status,
    v_redirect_group_id
  from public.search_term_groups
  where id = v_group_id;

  if v_group_status = 'ignored' then
    return jsonb_build_object(
      'ok', true,
      'counted', false,
      'reason', 'ignored_group',
      'group_id', v_group_id
    );
  end if;

  if v_group_status = 'merged' and v_redirect_group_id is not null then
    v_group_id := v_redirect_group_id;
  end if;

  insert into public.search_term_aliases (
    normalized_alias,
    display_alias,
    group_id,
    created_at,
    last_seen_at
  )
  values (
    v_normalized_term,
    coalesce(nullif(v_display_term, ''), v_normalized_term),
    v_group_id,
    v_now,
    v_now
  )
  on conflict (normalized_alias)
  do update set
    display_alias = excluded.display_alias,
    last_seen_at = excluded.last_seen_at;

  v_counted_group_id := null;

  insert into public.search_analytics_recent_dedupe (
    group_id,
    search_type,
    searcher_hash,
    last_searched_at,
    expires_at
  )
  values (
    v_group_id,
    v_search_type,
    p_searcher_hash,
    v_now,
    v_now + interval '20 minutes'
  )
  on conflict (group_id, search_type, searcher_hash)
  do update set
    last_searched_at = excluded.last_searched_at,
    expires_at = excluded.expires_at
  where public.search_analytics_recent_dedupe.expires_at <= v_now
  returning group_id
  into v_counted_group_id;

  if v_counted_group_id is null then
    return jsonb_build_object(
      'ok', true,
      'counted', false,
      'reason', 'recent_duplicate',
      'group_id', v_group_id
    );
  end if;

  insert into public.search_analytics_unique_daily (
    search_date,
    group_id,
    search_type,
    searcher_hash,
    created_at
  )
  values (
    v_today,
    v_group_id,
    v_search_type,
    p_searcher_hash,
    v_now
  )
  on conflict do nothing;

  get diagnostics v_unique_added = row_count;

  if v_result_count = 0 then
    v_no_result := 1;
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
  values (
    v_today,
    v_group_id,
    v_search_type,
    1,
    v_unique_added,
    v_no_result,
    0,
    v_result_count,
    v_now,
    v_now
  )
  on conflict (search_date, group_id, search_type)
  do update set
    searches =
      public.search_analytics_daily.searches + 1,
    unique_searchers =
      public.search_analytics_daily.unique_searchers +
      excluded.unique_searchers,
    no_result_searches =
      public.search_analytics_daily.no_result_searches +
      excluded.no_result_searches,
    result_count_total =
      public.search_analytics_daily.result_count_total +
      excluded.result_count_total,
    updated_at = excluded.updated_at;

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
  values (
    v_today,
    v_group_id,
    v_search_type,
    v_normalized_term,
    coalesce(nullif(v_display_term, ''), v_normalized_term),
    1,
    v_no_result,
    v_now
  )
  on conflict (
    search_date,
    group_id,
    search_type,
    normalized_term
  )
  do update set
    display_term = excluded.display_term,
    searches =
      public.search_term_variants_daily.searches + 1,
    no_result_searches =
      public.search_term_variants_daily.no_result_searches +
      excluded.no_result_searches,
    last_seen_at = excluded.last_seen_at;

  return jsonb_build_object(
    'ok', true,
    'counted', true,
    'group_id', v_group_id,
    'unique_added', v_unique_added = 1,
    'no_result', v_no_result = 1
  );
end;
$$;

revoke all
on function public.record_search_analytics_event(
  text,
  text,
  text,
  text,
  integer
)
from public, anon, authenticated;

grant execute
on function public.record_search_analytics_event(
  text,
  text,
  text,
  text,
  integer
)
to service_role;
