create table if not exists public.search_analytics_click_dedupe (
  group_id bigint not null
    references public.search_term_groups(id) on delete cascade,
  search_type text not null default 'all'
    check (
      search_type in (
        'all',
        'readers',
        'pages',
        'stories',
        'pdfs',
        'posts'
      )
    ),
  searcher_hash text not null,
  target_key text not null,
  last_clicked_at timestamptz not null default now(),
  expires_at timestamptz not null
    default (now() + interval '20 minutes'),
  primary key (
    group_id,
    search_type,
    searcher_hash,
    target_key
  )
);

create index if not exists idx_search_click_dedupe_expires
  on public.search_analytics_click_dedupe(expires_at);

alter table public.search_analytics_click_dedupe
  enable row level security;

revoke all
on table public.search_analytics_click_dedupe
from anon, authenticated;

grant all
on table public.search_analytics_click_dedupe
to service_role;

create or replace function public.record_search_analytics_click(
  p_normalized_term text,
  p_search_type text,
  p_searcher_hash text,
  p_target_key text
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
  v_normalized_term text :=
    left(lower(trim(coalesce(p_normalized_term, ''))), 120);
  v_search_type text :=
    lower(trim(coalesce(p_search_type, 'all')));
  v_target_key text :=
    left(trim(coalesce(p_target_key, '')), 220);
begin
  if length(v_normalized_term) < 2 then
    return jsonb_build_object(
      'counted',
      false,
      'reason',
      'term_too_short'
    );
  end if;

  if length(trim(coalesce(p_searcher_hash, ''))) < 16 then
    return jsonb_build_object(
      'counted',
      false,
      'reason',
      'missing_searcher'
    );
  end if;

  if length(v_target_key) < 3 then
    return jsonb_build_object(
      'counted',
      false,
      'reason',
      'missing_target'
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

  select a.group_id
  into v_group_id
  from public.search_term_aliases a
  where a.normalized_alias = v_normalized_term
  limit 1;

  if v_group_id is null then
    return jsonb_build_object(
      'counted',
      false,
      'reason',
      'group_not_found'
    );
  end if;

  select
    g.status,
    g.merged_into
  into
    v_group_status,
    v_redirect_group_id
  from public.search_term_groups g
  where g.id = v_group_id;

  if v_group_status = 'ignored' then
    return jsonb_build_object(
      'counted',
      false,
      'reason',
      'ignored_group',
      'group_id',
      v_group_id
    );
  end if;

  if (
    v_group_status = 'merged' and
    v_redirect_group_id is not null
  ) then
    v_group_id := v_redirect_group_id;
  end if;

  v_counted_group_id := null;

  insert into public.search_analytics_click_dedupe (
    group_id,
    search_type,
    searcher_hash,
    target_key,
    last_clicked_at,
    expires_at
  )
  values (
    v_group_id,
    v_search_type,
    p_searcher_hash,
    v_target_key,
    v_now,
    v_now + interval '20 minutes'
  )
  on conflict (
    group_id,
    search_type,
    searcher_hash,
    target_key
  )
  do update set
    last_clicked_at = excluded.last_clicked_at,
    expires_at = excluded.expires_at
  where
    public.search_analytics_click_dedupe.expires_at <= v_now
  returning group_id
  into v_counted_group_id;

  if v_counted_group_id is null then
    return jsonb_build_object(
      'counted',
      false,
      'reason',
      'recent_duplicate',
      'group_id',
      v_group_id
    );
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
    0,
    0,
    0,
    1,
    0,
    v_now,
    v_now
  )
  on conflict (
    search_date,
    group_id,
    search_type
  )
  do update set
    clicks =
      public.search_analytics_daily.clicks + 1,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'counted',
    true,
    'group_id',
    v_group_id
  );
end;
$$;

revoke all
on function public.record_search_analytics_click(
  text,
  text,
  text,
  text
)
from public, anon, authenticated;

grant execute
on function public.record_search_analytics_click(
  text,
  text,
  text,
  text
)
to service_role;

create or replace function public.purge_search_analytics()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff date := current_date - 90;
  v_daily integer := 0;
  v_variants integer := 0;
  v_unique integer := 0;
  v_recent integer := 0;
  v_click_recent integer := 0;
begin
  delete from public.search_analytics_daily
  where search_date < v_cutoff;
  get diagnostics v_daily = row_count;

  delete from public.search_term_variants_daily
  where search_date < v_cutoff;
  get diagnostics v_variants = row_count;

  delete from public.search_analytics_unique_daily
  where search_date < v_cutoff;
  get diagnostics v_unique = row_count;

  delete from public.search_analytics_recent_dedupe
  where expires_at <= now();
  get diagnostics v_recent = row_count;

  delete from public.search_analytics_click_dedupe
  where expires_at <= now();
  get diagnostics v_click_recent = row_count;

  return jsonb_build_object(
    'cutoff_date',
    v_cutoff,
    'daily_deleted',
    v_daily,
    'variants_deleted',
    v_variants,
    'unique_deleted',
    v_unique,
    'dedupe_deleted',
    v_recent,
    'click_dedupe_deleted',
    v_click_recent
  );
end;
$$;

revoke all
on function public.purge_search_analytics()
from public, anon, authenticated;

grant execute
on function public.purge_search_analytics()
to service_role;
