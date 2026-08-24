create or replace function public.get_search_analytics_admin_complete(
  p_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base jsonb;
  v_ignored jsonb;
begin
  v_base := public.get_search_analytics_admin(p_days);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',
        item.id,
        'term',
        item.canonical_term,
        'updated_at',
        item.updated_at,
        'aliases',
        item.aliases
      )
      order by item.updated_at desc
    ),
    '[]'::jsonb
  )
  into v_ignored
  from (
    select
      g.id,
      g.canonical_term,
      g.updated_at,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'term',
              alias_rows.display_alias,
              'normalized_term',
              alias_rows.normalized_alias
            )
            order by alias_rows.last_seen_at desc
          )
          from (
            select
              a.display_alias,
              a.normalized_alias,
              a.last_seen_at
            from public.search_term_aliases a
            where a.group_id = g.id
            order by a.last_seen_at desc
            limit 8
          ) alias_rows
        ),
        '[]'::jsonb
      ) as aliases
    from public.search_term_groups g
    where g.status = 'ignored'
    order by g.updated_at desc
    limit 50
  ) item;

  return
    coalesce(v_base, '{}'::jsonb) ||
    jsonb_build_object(
      'ignored_groups',
      coalesce(v_ignored, '[]'::jsonb)
    );
end;
$$;

revoke all
on function public.get_search_analytics_admin_complete(integer)
from public, anon, authenticated;

grant execute
on function public.get_search_analytics_admin_complete(integer)
to service_role;

create or replace function public.split_search_analytics_alias(
  p_source_group_id bigint,
  p_normalized_alias text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_alias text :=
    left(
      lower(trim(coalesce(p_normalized_alias, ''))),
      120
    );
  v_source_status text;
  v_source_normalized text;
  v_alias_display text;
  v_alias_group_id bigint;
  v_alias_count integer;
  v_fallback_normalized text;
  v_fallback_display text;
  v_existing_group_id bigint;
  v_existing_status text;
  v_existing_merged_into bigint;
  v_new_group_id bigint;
begin
  if p_source_group_id is null
    or p_source_group_id <= 0
    or length(v_alias) = 0 then
    raise exception 'Valid source group and alias are required';
  end if;

  select
    g.status,
    g.normalized_term
  into
    v_source_status,
    v_source_normalized
  from public.search_term_groups g
  where g.id = p_source_group_id
  for update;

  if not found then
    raise exception 'Source search group not found';
  end if;

  if v_source_status <> 'active' then
    raise exception 'Source group must be active';
  end if;

  select
    a.group_id,
    a.display_alias
  into
    v_alias_group_id,
    v_alias_display
  from public.search_term_aliases a
  where a.normalized_alias = v_alias
  for update;

  if not found then
    raise exception 'Search alias not found';
  end if;

  if v_alias_group_id <> p_source_group_id then
    raise exception 'Search alias does not belong to this group';
  end if;

  select count(*)::integer
  into v_alias_count
  from public.search_term_aliases a
  where a.group_id = p_source_group_id;

  if v_alias_count <= 1 then
    raise exception 'A group with one alias cannot be split';
  end if;

  if v_source_normalized = v_alias then
    select
      a.normalized_alias,
      a.display_alias
    into
      v_fallback_normalized,
      v_fallback_display
    from public.search_term_aliases a
    where a.group_id = p_source_group_id
      and a.normalized_alias <> v_alias
    order by a.last_seen_at desc
    limit 1;

    if v_fallback_normalized is null then
      raise exception 'A fallback alias is required before splitting';
    end if;

    if exists (
      select 1
      from public.search_term_groups g
      where g.normalized_term = v_fallback_normalized
        and g.id <> p_source_group_id
    ) then
      raise exception 'Fallback alias already belongs to another group key';
    end if;

    update public.search_term_groups
    set
      normalized_term = v_fallback_normalized,
      canonical_term =
        case
          when lower(trim(canonical_term)) = v_alias
          then v_fallback_display
          else canonical_term
        end,
      updated_at = v_now
    where id = p_source_group_id;
  end if;

  select
    g.id,
    g.status,
    g.merged_into
  into
    v_existing_group_id,
    v_existing_status,
    v_existing_merged_into
  from public.search_term_groups g
  where g.normalized_term = v_alias
    and g.id <> p_source_group_id
  limit 1
  for update;

  if v_existing_group_id is not null then
    if
      v_existing_status = 'merged'
      and v_existing_merged_into = p_source_group_id
    then
      update public.search_term_groups
      set
        canonical_term = v_alias_display,
        status = 'active',
        merged_into = null,
        updated_at = v_now
      where id = v_existing_group_id;

      v_new_group_id := v_existing_group_id;
    else
      raise exception 'Alias group key already exists and cannot be restored';
    end if;
  else
    insert into public.search_term_groups (
      canonical_term,
      normalized_term,
      status,
      merged_into,
      created_at,
      updated_at
    )
    values (
      v_alias_display,
      v_alias,
      'active',
      null,
      v_now,
      v_now
    )
    returning id
    into v_new_group_id;
  end if;

  update public.search_term_aliases
  set
    group_id = v_new_group_id,
    last_seen_at = greatest(last_seen_at, v_now)
  where normalized_alias = v_alias;

  update public.search_term_groups
  set updated_at = v_now
  where id = p_source_group_id;

  return jsonb_build_object(
    'source_group_id',
    p_source_group_id,
    'new_group_id',
    v_new_group_id,
    'alias',
    v_alias_display,
    'future_only',
    true
  );
end;
$$;

revoke all
on function public.split_search_analytics_alias(bigint, text)
from public, anon, authenticated;

grant execute
on function public.split_search_analytics_alias(bigint, text)
to service_role;
