create table if not exists public.resource_cost_provider_observations (
  provider text not null,
  metric text not null,
  scope text not null,
  observed_hour timestamptz not null,
  observed_at timestamptz not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  kind text not null,
  unit text not null,
  value numeric(25, 4),
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, metric, scope, observed_hour),
  constraint resource_cost_provider_valid check (provider in ('render', 'supabase', 'cloudflare_r2')),
  constraint resource_cost_provider_metric_valid check (metric ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  constraint resource_cost_provider_scope_valid check (scope ~ '^[a-z][a-z0-9_.:-]{0,119}$'),
  constraint resource_cost_provider_kind_valid check (kind in ('interval', 'cumulative', 'gauge')),
  constraint resource_cost_provider_unit_valid check (unit in ('bytes', 'requests', 'objects', 'usd', 'gb_month')),
  constraint resource_cost_provider_status_valid check (status in ('ok', 'partial', 'missing', 'error')),
  constraint resource_cost_provider_value_valid check (value is null or value >= 0),
  constraint resource_cost_provider_success_value_valid check (status <> 'ok' or value is not null),
  constraint resource_cost_provider_period_valid check (period_end > period_start),
  constraint resource_cost_provider_hour_valid check (observed_hour = date_trunc('hour', observed_hour))
);

create index if not exists resource_cost_provider_time_idx
  on public.resource_cost_provider_observations (observed_at desc, provider);

alter table public.resource_cost_provider_observations enable row level security;

create or replace function public.resource_cost_save_provider_observations(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_count integer := 0;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Invalid provider observation batch';
  end if;

  insert into public.resource_cost_provider_observations (
    provider, metric, scope, observed_hour, observed_at, period_start, period_end,
    kind, unit, value, status
  )
  select
    r.provider, r.metric, r.scope, r.observed_hour, r.observed_at,
    r.period_start, r.period_end, r.kind, r.unit, r.value, r.status
  from jsonb_to_recordset(p_rows) as r (
    provider text, metric text, scope text, observed_hour timestamptz,
    observed_at timestamptz, period_start timestamptz, period_end timestamptz,
    kind text, unit text, value numeric, status text
  )
  on conflict (provider, metric, scope, observed_hour)
  do update set
    observed_at = excluded.observed_at,
    period_start = excluded.period_start,
    period_end = excluded.period_end,
    kind = excluded.kind,
    unit = excluded.unit,
    value = excluded.value,
    status = excluded.status,
    updated_at = now()
  where excluded.observed_at >= public.resource_cost_provider_observations.observed_at;

  get diagnostics saved_count = row_count;
  return saved_count;
end;
$$;

create table if not exists public.resource_cost_upload_batches (
  batch_id uuid primary key,
  item_count integer not null check (item_count between 1 and 512),
  committed_at timestamptz not null default now()
);

create table if not exists public.resource_cost_upload_hourly (
  hour_start timestamptz not null,
  feature text not null,
  route text not null,
  upload_mode text not null,
  attempts bigint not null default 0,
  successes bigint not null default 0,
  failures bigint not null default 0,
  ingress_bytes bigint not null default 0,
  egress_bytes bigint not null default 0,
  object_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (hour_start, feature, route, upload_mode),
  constraint resource_cost_upload_hour_valid check (hour_start = date_trunc('hour', hour_start)),
  constraint resource_cost_upload_feature_valid check (feature ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  constraint resource_cost_upload_route_valid check (route ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
  constraint resource_cost_upload_mode_valid check (upload_mode in ('direct', 'proxy', 'background')),
  constraint resource_cost_upload_counts_valid check (
    attempts >= 0 and successes >= 0 and failures >= 0 and
    attempts = successes + failures and
    ingress_bytes >= 0 and egress_bytes >= 0 and object_bytes >= 0
  )
);

create index if not exists resource_cost_upload_recent_idx
  on public.resource_cost_upload_hourly (hour_start desc, upload_mode);

alter table public.resource_cost_upload_batches enable row level security;
alter table public.resource_cost_upload_hourly enable row level security;

create or replace function public.resource_cost_commit_upload_batch(p_batch_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  accepted_id uuid;
  saved_count integer := 0;
begin
  if p_batch_id is null or jsonb_typeof(p_rows) is distinct from 'array' or
     jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 512 then
    raise exception 'Invalid upload audit batch';
  end if;

  insert into public.resource_cost_upload_batches (batch_id, item_count)
  values (p_batch_id, jsonb_array_length(p_rows))
  on conflict (batch_id) do nothing
  returning batch_id into accepted_id;

  if accepted_id is null then
    return jsonb_build_object('applied', false, 'rows', 0);
  end if;

  insert into public.resource_cost_upload_hourly (
    hour_start, feature, route, upload_mode, attempts, successes, failures,
    ingress_bytes, egress_bytes, object_bytes
  )
  select
    r.hour_start, r.feature, r.route, r.upload_mode,
    sum(r.attempts), sum(r.successes), sum(r.failures),
    sum(r.ingress_bytes), sum(r.egress_bytes), sum(r.object_bytes)
  from jsonb_to_recordset(p_rows) as r (
    hour_start timestamptz, feature text, route text, upload_mode text,
    attempts bigint, successes bigint, failures bigint,
    ingress_bytes bigint, egress_bytes bigint, object_bytes bigint
  )
  group by r.hour_start, r.feature, r.route, r.upload_mode
  on conflict (hour_start, feature, route, upload_mode)
  do update set
    attempts = public.resource_cost_upload_hourly.attempts + excluded.attempts,
    successes = public.resource_cost_upload_hourly.successes + excluded.successes,
    failures = public.resource_cost_upload_hourly.failures + excluded.failures,
    ingress_bytes = public.resource_cost_upload_hourly.ingress_bytes + excluded.ingress_bytes,
    egress_bytes = public.resource_cost_upload_hourly.egress_bytes + excluded.egress_bytes,
    object_bytes = public.resource_cost_upload_hourly.object_bytes + excluded.object_bytes,
    updated_at = now();

  get diagnostics saved_count = row_count;
  return jsonb_build_object('applied', true, 'rows', saved_count);
end;
$$;

revoke all on function public.resource_cost_save_provider_observations(jsonb) from public, anon, authenticated;
revoke all on function public.resource_cost_commit_upload_batch(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.resource_cost_save_provider_observations(jsonb) to service_role;
grant execute on function public.resource_cost_commit_upload_batch(uuid, jsonb) to service_role;
