create or replace function public.get_system_usage_error_history(
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  result jsonb;
  max_groups integer := least(200, greatest(1, coalesce(p_limit, 100)));
begin
  if p_from is null or p_to is null or p_to <= p_from
    or p_to - p_from > interval '7 days' then
    raise exception 'A valid date range of at most 7 days is required'
      using errcode = '22023';
  end if;

  with windows as materialized (
    select window_start, window_end, payload
    from public.system_usage_snapshots
    where window_end > p_from and window_start < p_to
  ),
  evidence as (
    select
      coalesce(nullif(item.value->>'route', ''), 'UNKNOWN') as route,
      case
        when item.value->>'http_status' ~ '^[0-9]{3}$'
          then (item.value->>'http_status')::integer
        else 0
      end as http_status,
      nullif(item.value->>'response_code', '') as response_code,
      coalesce(nullif(item.value->>'error_class', ''), 'unknown') as error_class,
      coalesce(nullif(item.value->>'provider', ''), 'UNKNOWN') as provider,
      coalesce(nullif(item.value->>'target', ''), 'UNKNOWN') as target,
      case
        when item.value->>'count' ~ '^[0-9]{1,18}$'
          then (item.value->>'count')::bigint
        else 0::bigint
      end as failures,
      case
        when item.value->>'external_error_count' ~ '^[0-9]{1,18}$'
          then (item.value->>'external_error_count')::bigint
        else 0::bigint
      end as external_failures,
      coalesce(nullif(item.value->>'first_seen_at', '')::timestamptz, w.window_start) as first_seen_at,
      coalesce(nullif(item.value->>'last_seen_at', '')::timestamptz, w.window_end) as last_seen_at,
      left(item.value->>'sample_request_id', 128) as sample_request_id,
      left(item.value->>'sample_error', 240) as sample_error,
      case
        when item.value->>'sample_duration_ms' ~ '^[0-9]{1,12}$'
          then (item.value->>'sample_duration_ms')::bigint
        else null::bigint
      end as sample_duration_ms
    from windows w
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(w.payload->'error_evidence') = 'array'
          then w.payload->'error_evidence'
        else '[]'::jsonb
      end
    ) as item(value)
  ),
  groups as (
    select
      route, http_status, response_code, error_class, provider, target,
      sum(failures)::bigint as count,
      sum(external_failures)::bigint as external_error_count,
      min(first_seen_at) as first_seen_at,
      max(last_seen_at) as last_seen_at,
      (array_agg(sample_request_id order by last_seen_at desc nulls last))[1] as sample_request_id,
      (array_agg(sample_error order by last_seen_at desc nulls last))[1] as sample_error,
      (array_agg(sample_duration_ms order by last_seen_at desc nulls last))[1] as sample_duration_ms
    from evidence
    group by route, http_status, response_code, error_class, provider, target
  ),
  ranked as (
    select *
    from groups
    order by count desc, last_seen_at desc
    limit max_groups
  )
  select jsonb_build_object(
    'source', 'stored_15_minute_snapshots',
    'history_complete', false,
    'window_start', p_from,
    'window_end', p_to,
    'bucket_minutes', 15,
    'stored_windows', (select count(*) from windows),
    'evidence_windows', (
      select count(*) from windows
      where jsonb_typeof(payload->'error_evidence') = 'array'
    ),
    'expected_windows', ceil(extract(epoch from (p_to - p_from)) / 900),
    'possibly_capped_windows', (
      select count(*) from windows
      where jsonb_typeof(payload->'error_evidence') = 'array'
        and jsonb_array_length(payload->'error_evidence') >=
          greatest(1, coalesce((payload->>'error_evidence_limit')::integer, 250))
    ),
    'total_observed', (select coalesce(sum(failures), 0) from evidence),
    'affected_routes', (select count(distinct route) from groups),
    'total_groups', (select count(*) from groups),
    'returned_groups', (select count(*) from ranked),
    'has_more', (select count(*) from groups) > max_groups,
    'errors', (select coalesce(jsonb_agg(to_jsonb(ranked) order by count desc, last_seen_at desc), '[]'::jsonb) from ranked)
  ) into result;

  return result;
end;
$$;

revoke execute on function public.get_system_usage_error_history(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.get_system_usage_error_history(timestamptz, timestamptz, integer)
  to service_role;
