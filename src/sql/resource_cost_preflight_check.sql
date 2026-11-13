with required_tables(name) as (
  values
    ('resource_cost_provider_observations'),
    ('resource_cost_upload_batches'),
    ('resource_cost_upload_hourly'),
    ('render_bandwidth_hourly'),
    ('system_usage_snapshots'),
    ('system_usage_rollups'),
    ('heavy_media_jobs')
),
required_columns(tbl, col) as (
  values
    ('resource_cost_provider_observations','provider'),
    ('resource_cost_provider_observations','metric'),
    ('resource_cost_provider_observations','scope'),
    ('resource_cost_provider_observations','observed_hour'),
    ('resource_cost_provider_observations','observed_at'),
    ('resource_cost_provider_observations','period_start'),
    ('resource_cost_provider_observations','period_end'),
    ('resource_cost_provider_observations','kind'),
    ('resource_cost_provider_observations','unit'),
    ('resource_cost_provider_observations','value'),
    ('resource_cost_provider_observations','status'),
    ('resource_cost_upload_batches','batch_id'),
    ('resource_cost_upload_batches','item_count'),
    ('resource_cost_upload_hourly','hour_start'),
    ('resource_cost_upload_hourly','feature'),
    ('resource_cost_upload_hourly','route'),
    ('resource_cost_upload_hourly','upload_mode'),
    ('resource_cost_upload_hourly','attempts'),
    ('resource_cost_upload_hourly','successes'),
    ('resource_cost_upload_hourly','failures'),
    ('resource_cost_upload_hourly','ingress_bytes'),
    ('resource_cost_upload_hourly','egress_bytes'),
    ('resource_cost_upload_hourly','object_bytes'),
    ('render_bandwidth_hourly','service_id'),
    ('render_bandwidth_hourly','hour_start'),
    ('render_bandwidth_hourly','total_bytes'),
    ('render_bandwidth_hourly','http_response_bytes'),
    ('render_bandwidth_hourly','service_initiated_bytes'),
    ('render_bandwidth_hourly','websocket_response_bytes'),
    ('render_bandwidth_hourly','private_link_bytes'),
    ('render_bandwidth_hourly','breakdown_available'),
    ('system_usage_snapshots','window_start'),
    ('system_usage_snapshots','window_end'),
    ('system_usage_snapshots','request_count'),
    ('system_usage_snapshots','bytes'),
    ('system_usage_snapshots','payload'),
    ('system_usage_rollups','granularity'),
    ('system_usage_rollups','bucket_start'),
    ('system_usage_rollups','bucket_end'),
    ('system_usage_rollups','request_count'),
    ('system_usage_rollups','bytes'),
    ('system_usage_rollups','payload'),
    ('heavy_media_jobs','id'),
    ('heavy_media_jobs','job_type'),
    ('heavy_media_jobs','created_at'),
    ('heavy_media_jobs','payload')
),
required_rpcs(signature) as (
  values
    ('resource_cost_save_provider_observations(jsonb)'),
    ('resource_cost_commit_upload_batch(uuid,jsonb)')
),
results as (
  select 'TABLE'::text as check_type, 'public.' || name as object_name,
    case when to_regclass(format('public.%I', name)) is null then 'MISSING' else 'PASS' end as status,
    'Required by Resource & Cost reporting'::text as details
  from required_tables

  union all

  select 'COLUMN', format('public.%I.%I', tbl, col),
    case when exists (
      select 1 from pg_attribute a
      where a.attrelid = to_regclass(format('public.%I', tbl))
        and a.attname = col and a.attnum > 0 and not a.attisdropped
    ) then 'PASS' else 'MISSING' end,
    'Referenced by the report query'
  from required_columns

  union all

  select 'RLS', 'public.' || name,
    case when c.oid is null then 'MISSING'
         when c.relrowsecurity then 'PASS' else 'FIX_REQUIRED' end,
    'Row-level security must be enabled'
  from (values ('resource_cost_provider_observations'),('resource_cost_upload_batches'),('resource_cost_upload_hourly')) t(name)
  left join pg_class c on c.oid = to_regclass(format('public.%I', name))

  union all

  select 'SELECT_PERMISSION', 'service_role on public.' || name,
    case when to_regclass(format('public.%I', name)) is null then 'MISSING'
         when coalesce(has_table_privilege('service_role',to_regclass(format('public.%I', name)),'SELECT'),false)
           then 'PASS' else 'FIX_REQUIRED' end,
    'Backend service role must read this table'
  from required_tables where name <> 'resource_cost_upload_batches'

  union all

  select 'RPC', 'public.' || signature,
    case when to_regprocedure('public.' || signature) is null then 'MISSING'
         when coalesce(has_function_privilege('service_role',to_regprocedure('public.' || signature),'EXECUTE'),false)
              and coalesce((select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.' || signature)),false)
           then 'PASS' else 'FIX_REQUIRED' end,
    'SECURITY DEFINER and service_role EXECUTE required'
  from required_rpcs

  union all

  select 'RPC_PUBLIC_ACCESS', 'public.' || signature,
    case when to_regprocedure('public.' || signature) is null then 'MISSING'
         when coalesce(has_function_privilege('anon',to_regprocedure('public.' || signature),'EXECUTE'),false)
           or coalesce(has_function_privilege('authenticated',to_regprocedure('public.' || signature),'EXECUTE'),false)
           then 'FIX_REQUIRED' else 'PASS' end,
    'anon and authenticated must not EXECUTE resource-cost write RPCs'
  from required_rpcs

  union all

  select 'PRIMARY_KEY', 'public.' || name,
    case when to_regclass(format('public.%I', name)) is null then 'MISSING'
         when exists (select 1 from pg_constraint c where c.conrelid = to_regclass(format('public.%I', name)) and c.contype = 'p')
           then 'PASS' else 'FIX_REQUIRED' end,
    'Needed for safe upserts and batch idempotency'
  from (values ('resource_cost_provider_observations'),('resource_cost_upload_batches'),('resource_cost_upload_hourly')) t(name)

  union all

  select 'INDEX', 'public.heavy_media_jobs_idempotency_idx',
    case when to_regclass('public.heavy_media_jobs_idempotency_idx') is null then 'MISSING'
         when exists (select 1 from pg_index i where i.indexrelid = to_regclass('public.heavy_media_jobs_idempotency_idx') and i.indisunique)
           then 'PASS' else 'FIX_REQUIRED' end,
    'Required for direct Manga retry deduplication'
)
select check_type, object_name, status, details
from results
order by case status when 'MISSING' then 0 when 'FIX_REQUIRED' then 1 else 2 end,
         check_type, object_name;
