create or replace function public.get_search_analytics_admin(
  p_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer := least(
    greatest(coalesce(p_days, 30), 1),
    90
  );
  v_current_start date :=
    current_date - (v_days - 1);
  v_current_end date := current_date;
  v_previous_start date :=
    current_date - ((v_days * 2) - 1);
  v_previous_end date :=
    current_date - v_days;
  v_result jsonb;
begin
  with resolved_daily as (
    select
      d.search_date,
      case
        when g.status = 'merged'
          and g.merged_into is not null
        then g.merged_into
        else d.group_id
      end as effective_group_id,
      d.search_type,
      d.searches,
      d.unique_searchers,
      d.no_result_searches,
      d.clicks,
      d.result_count_total
    from public.search_analytics_daily d
    join public.search_term_groups g
      on g.id = d.group_id
    where g.status <> 'ignored'
      and d.search_date between
        v_previous_start and v_current_end
  ),
  current_daily as (
    select *
    from resolved_daily
    where search_date between
      v_current_start and v_current_end
  ),
  previous_daily as (
    select *
    from resolved_daily
    where search_date between
      v_previous_start and v_previous_end
  ),
  current_summary as (
    select
      coalesce(sum(searches), 0)::bigint
        as searches,
      coalesce(sum(no_result_searches), 0)::bigint
        as no_result_searches,
      coalesce(sum(clicks), 0)::bigint
        as clicks,
      count(distinct effective_group_id)::bigint
        as unique_terms
    from current_daily
  ),
  previous_summary as (
    select
      coalesce(sum(searches), 0)::bigint
        as searches,
      coalesce(sum(no_result_searches), 0)::bigint
        as no_result_searches,
      coalesce(sum(clicks), 0)::bigint
        as clicks,
      count(distinct effective_group_id)::bigint
        as unique_terms
    from previous_daily
  ),
  date_series as (
    select generate_series(
      v_current_start::timestamp,
      v_current_end::timestamp,
      interval '1 day'
    )::date as search_date
  ),
  trend_rows as (
    select
      s.search_date,
      coalesce(sum(d.searches), 0)::bigint
        as searches,
      coalesce(
        sum(d.no_result_searches),
        0
      )::bigint as no_result_searches,
      coalesce(sum(d.clicks), 0)::bigint
        as clicks
    from date_series s
    left join current_daily d
      on d.search_date = s.search_date
    group by s.search_date
    order by s.search_date
  ),
  type_rows as (
    select
      search_type,
      sum(searches)::bigint as searches,
      sum(no_result_searches)::bigint
        as no_result_searches,
      sum(clicks)::bigint as clicks
    from current_daily
    group by search_type
  ),
  current_groups as (
    select
      effective_group_id as group_id,
      sum(searches)::bigint as searches,
      sum(unique_searchers)::bigint
        as unique_searchers,
      sum(no_result_searches)::bigint
        as no_result_searches,
      sum(clicks)::bigint as clicks,
      sum(result_count_total)::bigint
        as result_count_total
    from current_daily
    group by effective_group_id
  ),
  previous_groups as (
    select
      effective_group_id as group_id,
      sum(searches)::bigint as searches
    from previous_daily
    group by effective_group_id
  ),
  group_rows as (
    select
      cg.group_id,
      g.canonical_term,
      cg.searches,
      cg.unique_searchers,
      cg.no_result_searches,
      cg.clicks,
      case
        when cg.searches > 0
        then round(
          (
            cg.clicks::numeric /
            cg.searches::numeric
          ) * 100,
          2
        )
        else 0
      end as ctr,
      case
        when cg.searches > 0
        then round(
          cg.result_count_total::numeric /
          cg.searches::numeric,
          2
        )
        else 0
      end as average_results,
      case
        when coalesce(pg.searches, 0) > 0
        then round(
          (
            (
              cg.searches -
              pg.searches
            )::numeric /
            pg.searches::numeric
          ) * 100,
          2
        )
        when cg.searches > 0
        then 100
        else 0
      end as trend_percent,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'term',
              alias_rows.display_alias,
              'normalized_term',
              alias_rows.normalized_alias
            )
            order by
              alias_rows.last_seen_at desc
          )
          from (
            select
              a.display_alias,
              a.normalized_alias,
              a.last_seen_at
            from public.search_term_aliases a
            where a.group_id = cg.group_id
            order by a.last_seen_at desc
            limit 6
          ) alias_rows
        ),
        '[]'::jsonb
      ) as aliases
    from current_groups cg
    join public.search_term_groups g
      on g.id = cg.group_id
    left join previous_groups pg
      on pg.group_id = cg.group_id
    where g.status <> 'ignored'
    order by
      cg.searches desc,
      cg.no_result_searches desc,
      cg.group_id
    limit 100
  ),
  totals_for_type as (
    select
      coalesce(sum(searches), 0)::numeric
        as total_searches
    from type_rows
  ),
  recent_activity_rows as (
    select
      a.id,
      case
        when g.status = 'merged'
          and g.merged_into is not null
        then g.merged_into
        else a.group_id
      end as effective_group_id,
      a.search_type,
      a.display_term,
      a.reader_id,
      a.result_count,
      a.searched_at
    from public.search_analytics_recent_activity a
    join public.search_term_groups g
      on g.id = a.group_id
    where g.status <> 'ignored'
      and a.searched_at >=
        v_current_start::timestamptz
    order by a.searched_at desc
    limit 30
  )
  select jsonb_build_object(
    'period',
    jsonb_build_object(
      'days',
      v_days,
      'from',
      v_current_start,
      'to',
      v_current_end,
      'previous_from',
      v_previous_start,
      'previous_to',
      v_previous_end
    ),
    'summary',
    jsonb_build_object(
      'searches',
      cs.searches,
      'unique_terms',
      cs.unique_terms,
      'no_result_searches',
      cs.no_result_searches,
      'clicks',
      cs.clicks,
      'ctr',
      case
        when cs.searches > 0
        then round(
          (
            cs.clicks::numeric /
            cs.searches::numeric
          ) * 100,
          2
        )
        else 0
      end,
      'searches_change',
      case
        when ps.searches > 0
        then round(
          (
            (
              cs.searches -
              ps.searches
            )::numeric /
            ps.searches::numeric
          ) * 100,
          2
        )
        when cs.searches > 0
        then 100
        else 0
      end,
      'unique_terms_change',
      case
        when ps.unique_terms > 0
        then round(
          (
            (
              cs.unique_terms -
              ps.unique_terms
            )::numeric /
            ps.unique_terms::numeric
          ) * 100,
          2
        )
        when cs.unique_terms > 0
        then 100
        else 0
      end,
      'no_result_change',
      case
        when ps.no_result_searches > 0
        then round(
          (
            (
              cs.no_result_searches -
              ps.no_result_searches
            )::numeric /
            ps.no_result_searches::numeric
          ) * 100,
          2
        )
        when cs.no_result_searches > 0
        then 100
        else 0
      end,
      'previous_searches',
      ps.searches,
      'previous_unique_terms',
      ps.unique_terms,
      'previous_no_result_searches',
      ps.no_result_searches
    ),
    'trend',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'date',
            t.search_date,
            'searches',
            t.searches,
            'no_result_searches',
            t.no_result_searches,
            'clicks',
            t.clicks
          )
          order by t.search_date
        )
        from trend_rows t
      ),
      '[]'::jsonb
    ),
    'types',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'type',
            tr.search_type,
            'searches',
            tr.searches,
            'no_result_searches',
            tr.no_result_searches,
            'clicks',
            tr.clicks,
            'percentage',
            case
              when tt.total_searches > 0
              then round(
                (
                  tr.searches::numeric /
                  tt.total_searches
                ) * 100,
                2
              )
              else 0
            end
          )
          order by tr.searches desc
        )
        from type_rows tr
        cross join totals_for_type tt
      ),
      '[]'::jsonb
    ),
    'groups',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id',
            gr.group_id,
            'term',
            gr.canonical_term,
            'searches',
            gr.searches,
            'unique_searchers',
            gr.unique_searchers,
            'no_result_searches',
            gr.no_result_searches,
            'clicks',
            gr.clicks,
            'ctr',
            gr.ctr,
            'average_results',
            gr.average_results,
            'trend_percent',
            gr.trend_percent,
            'aliases',
            gr.aliases
          )
          order by
            gr.searches desc,
            gr.no_result_searches desc
        )
        from group_rows gr
      ),
      '[]'::jsonb
    ),
    'recent_activity',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id',
            r.id,
            'group_id',
            r.effective_group_id,
            'reader_id',
            r.reader_id,
            'search_term',
            r.display_term,
            'search_type',
            r.search_type,
            'result_count',
            r.result_count,
            'searched_at',
            r.searched_at
          )
          order by r.searched_at desc
        )
        from recent_activity_rows r
      ),
      '[]'::jsonb
    )
  )
  into v_result
  from current_summary cs
  cross join previous_summary ps;

  return coalesce(
    v_result,
    jsonb_build_object(
      'period',
      jsonb_build_object(
        'days',
        v_days,
        'from',
        v_current_start,
        'to',
        v_current_end
      ),
      'summary',
      jsonb_build_object(
        'searches',
        0,
        'unique_terms',
        0,
        'no_result_searches',
        0,
        'clicks',
        0,
        'ctr',
        0
      ),
      'trend',
      '[]'::jsonb,
      'types',
      '[]'::jsonb,
      'groups',
      '[]'::jsonb,
      'recent_activity',
      '[]'::jsonb
    )
  );
end;
$$;

revoke all
on function public.get_search_analytics_admin(integer)
from public, anon, authenticated;

grant execute
on function public.get_search_analytics_admin(integer)
to service_role;
