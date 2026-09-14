create table if not exists public.work_incidents (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  source text not null check (source in ('WEB', 'ADMIN', 'BACKEND', 'UNKNOWN')),
  method text not null,
  path text not null,
  status text not null default 'active' check (status in ('active', 'resolved')),
  peak_requests_per_minute integer not null default 0 check (peak_requests_per_minute >= 0),
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  reopen_count integer not null default 0 check (reopen_count >= 0),
  occurrence_count integer not null default 1 check (occurrence_count >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists work_incidents_status_updated_idx
  on public.work_incidents (status, updated_at desc);

create index if not exists work_incidents_resolved_at_idx
  on public.work_incidents (resolved_at)
  where status = 'resolved';

alter table public.work_incidents enable row level security;

create or replace function public.upsert_work_incident(
  p_fingerprint text,
  p_source text,
  p_method text,
  p_path text,
  p_peak_requests_per_minute integer,
  p_detected_at timestamptz,
  p_last_detected_at timestamptz
)
returns public.work_incidents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.work_incidents;
begin
  insert into public.work_incidents (
    fingerprint,
    source,
    method,
    path,
    status,
    peak_requests_per_minute,
    first_detected_at,
    last_detected_at,
    resolved_at,
    reopen_count,
    occurrence_count,
    created_at,
    updated_at
  )
  values (
    p_fingerprint,
    p_source,
    p_method,
    p_path,
    'active',
    greatest(coalesce(p_peak_requests_per_minute, 0), 0),
    coalesce(p_detected_at, now()),
    coalesce(p_last_detected_at, p_detected_at, now()),
    null,
    0,
    1,
    now(),
    now()
  )
  on conflict (fingerprint) do update
  set
    source = excluded.source,
    method = excluded.method,
    path = excluded.path,
    status = 'active',
    peak_requests_per_minute = greatest(
      public.work_incidents.peak_requests_per_minute,
      excluded.peak_requests_per_minute
    ),
    first_detected_at = least(
      public.work_incidents.first_detected_at,
      excluded.first_detected_at
    ),
    last_detected_at = greatest(
      public.work_incidents.last_detected_at,
      excluded.last_detected_at
    ),
    resolved_at = null,
    reopen_count = public.work_incidents.reopen_count
      + case when public.work_incidents.status = 'resolved' then 1 else 0 end,
    occurrence_count = public.work_incidents.occurrence_count + 1,
    updated_at = now()
  returning * into v_record;

  return v_record;
end;
$$;

revoke all on function public.upsert_work_incident(
  text,
  text,
  text,
  text,
  integer,
  timestamptz,
  timestamptz
) from public;

grant execute on function public.upsert_work_incident(
  text,
  text,
  text,
  text,
  integer,
  timestamptz,
  timestamptz
) to service_role;
