create extension if not exists pgcrypto;

create table if not exists public.heavy_media_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.users(id)
    on delete cascade,
  job_type text not null,
  status text not null default 'queued',
  priority smallint not null default 100,
  temp_object_key text,
  final_object_key text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error_code text,
  error_message text,
  idempotency_key text,
  attempt_count smallint not null default 0,
  max_attempts smallint not null default 3,
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  worker_id text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint heavy_media_jobs_job_type_check
    check (
      char_length(trim(job_type)) between 1 and 80
    ),
  constraint heavy_media_jobs_status_check
    check (
      status in (
        'queued',
        'processing',
        'done',
        'failed',
        'cancelled'
      )
    ),
  constraint heavy_media_jobs_priority_check
    check (
      priority between 0 and 1000
    ),
  constraint heavy_media_jobs_attempt_count_check
    check (
      attempt_count >= 0
    ),
  constraint heavy_media_jobs_max_attempts_check
    check (
      max_attempts between 1 and 10
    )
);

create index if not exists
heavy_media_jobs_queue_idx
on public.heavy_media_jobs (
  status,
  priority desc,
  available_at,
  created_at
);

create index if not exists
heavy_media_jobs_user_idx
on public.heavy_media_jobs (
  user_id,
  created_at desc
);

create index if not exists
heavy_media_jobs_lease_idx
on public.heavy_media_jobs (
  lease_expires_at
)
where status = 'processing';

create unique index if not exists
heavy_media_jobs_idempotency_idx
on public.heavy_media_jobs (
  user_id,
  idempotency_key
)
where idempotency_key is not null;

create or replace function
public.touch_heavy_media_job_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists
touch_heavy_media_job_updated_at_trigger
on public.heavy_media_jobs;

create trigger
touch_heavy_media_job_updated_at_trigger
before update
on public.heavy_media_jobs
for each row
execute function
public.touch_heavy_media_job_updated_at();

create or replace function
public.claim_next_heavy_media_job(
  p_worker_id text,
  p_lease_seconds integer default 300,
  p_job_types text[] default null
)
returns setof public.heavy_media_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'worker_id is required';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 30 and 3600';
  end if;

  return query
  with next_job as (
    select j.id
    from public.heavy_media_jobs j
    where j.status = 'queued'
      and j.available_at <= now()
      and j.attempt_count < j.max_attempts
      and (
        p_job_types is null
        or cardinality(p_job_types) = 0
        or j.job_type = any(p_job_types)
      )
    order by
      j.priority desc,
      j.created_at asc
    for update skip locked
    limit 1
  )
  update public.heavy_media_jobs j
  set
    status = 'processing',
    worker_id = trim(p_worker_id),
    attempt_count = j.attempt_count + 1,
    lease_expires_at =
      now() + make_interval(secs => p_lease_seconds),
    started_at = now(),
    finished_at = null,
    error_code = null,
    error_message = null
  from next_job
  where j.id = next_job.id
  returning j.*;
end;
$$;

create or replace function
public.renew_heavy_media_job_lease(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.heavy_media_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'worker_id is required';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 30 and 3600';
  end if;

  return query
  update public.heavy_media_jobs j
  set
    lease_expires_at =
      now() + make_interval(secs => p_lease_seconds)
  where j.id = p_job_id
    and j.status = 'processing'
    and j.worker_id = trim(p_worker_id)
  returning j.*;
end;
$$;

create or replace function
public.complete_heavy_media_job(
  p_job_id uuid,
  p_worker_id text,
  p_result jsonb default '{}'::jsonb,
  p_final_object_key text default null
)
returns setof public.heavy_media_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'worker_id is required';
  end if;

  return query
  update public.heavy_media_jobs j
  set
    status = 'done',
    result = coalesce(p_result, '{}'::jsonb),
    final_object_key =
      coalesce(nullif(trim(p_final_object_key), ''), j.final_object_key),
    worker_id = null,
    lease_expires_at = null,
    finished_at = now(),
    error_code = null,
    error_message = null
  where j.id = p_job_id
    and j.status = 'processing'
    and j.worker_id = trim(p_worker_id)
  returning j.*;
end;
$$;

create or replace function
public.fail_heavy_media_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_retry boolean default true,
  p_retry_delay_seconds integer default 30
)
returns setof public.heavy_media_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'worker_id is required';
  end if;

  if p_retry_delay_seconds < 0
    or p_retry_delay_seconds > 86400 then
    raise exception
      'retry_delay_seconds must be between 0 and 86400';
  end if;

  return query
  update public.heavy_media_jobs j
  set
    status = case
      when p_retry
        and j.attempt_count < j.max_attempts
      then 'queued'
      else 'failed'
    end,
    available_at = case
      when p_retry
        and j.attempt_count < j.max_attempts
      then now() + make_interval(
        secs => p_retry_delay_seconds
      )
      else j.available_at
    end,
    worker_id = null,
    lease_expires_at = null,
    finished_at = case
      when p_retry
        and j.attempt_count < j.max_attempts
      then null
      else now()
    end,
    error_code =
      left(coalesce(nullif(trim(p_error_code), ''), 'JOB_FAILED'), 120),
    error_message =
      left(coalesce(p_error_message, ''), 1000)
  where j.id = p_job_id
    and j.status = 'processing'
    and j.worker_id = trim(p_worker_id)
  returning j.*;
end;
$$;

alter table public.heavy_media_jobs
enable row level security;

revoke all
on public.heavy_media_jobs
from public, anon, authenticated;

grant all
on public.heavy_media_jobs
to service_role;

revoke all
on function public.touch_heavy_media_job_updated_at()
from public, anon, authenticated;

revoke all
on function public.claim_next_heavy_media_job(
  text,
  integer,
  text[]
)
from public, anon, authenticated;

revoke all
on function public.renew_heavy_media_job_lease(
  uuid,
  text,
  integer
)
from public, anon, authenticated;

revoke all
on function public.complete_heavy_media_job(
  uuid,
  text,
  jsonb,
  text
)
from public, anon, authenticated;

revoke all
on function public.fail_heavy_media_job(
  uuid,
  text,
  text,
  text,
  boolean,
  integer
)
from public, anon, authenticated;

grant execute
on function public.claim_next_heavy_media_job(
  text,
  integer,
  text[]
)
to service_role;

grant execute
on function public.renew_heavy_media_job_lease(
  uuid,
  text,
  integer
)
to service_role;

grant execute
on function public.complete_heavy_media_job(
  uuid,
  text,
  jsonb,
  text
)
to service_role;

grant execute
on function public.fail_heavy_media_job(
  uuid,
  text,
  text,
  text,
  boolean,
  integer
)
to service_role;
