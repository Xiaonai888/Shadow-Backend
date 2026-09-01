create or replace function
public.guard_heavy_media_job_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_active_count integer;
  global_active_count integer;
begin
  if new.job_type <> 'manga_page_v2' then
    return new;
  end if;

  perform pg_advisory_xact_lock(83429101);

  select count(*)
  into user_active_count
  from public.heavy_media_jobs
  where user_id = new.user_id
    and status in ('queued', 'processing');

  if user_active_count >= 40 then
    raise exception
      'MANGA_USER_QUEUE_FULL'
      using errcode = 'P0001';
  end if;

  select count(*)
  into global_active_count
  from public.heavy_media_jobs
  where status in ('queued', 'processing');

  if global_active_count >= 200 then
    raise exception
      'MANGA_GLOBAL_QUEUE_FULL'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists
guard_heavy_media_job_capacity_trigger
on public.heavy_media_jobs;

create trigger
guard_heavy_media_job_capacity_trigger
before insert
on public.heavy_media_jobs
for each row
execute function
public.guard_heavy_media_job_capacity();

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

  if p_lease_seconds < 30
    or p_lease_seconds > 3600 then
    raise exception
      'lease_seconds must be between 30 and 3600';
  end if;

  update public.heavy_media_jobs j
  set
    status = case
      when j.attempt_count < j.max_attempts
      then 'queued'
      else 'failed'
    end,
    available_at = case
      when j.attempt_count < j.max_attempts
      then now() + interval '15 seconds'
      else j.available_at
    end,
    worker_id = null,
    lease_expires_at = null,
    started_at = case
      when j.attempt_count < j.max_attempts
      then null
      else j.started_at
    end,
    finished_at = case
      when j.attempt_count < j.max_attempts
      then null
      else now()
    end,
    error_code = 'WORKER_LEASE_EXPIRED',
    error_message = case
      when j.attempt_count < j.max_attempts
      then
        'The worker lease expired. The job was returned to the queue.'
      else
        'The worker lease expired after the maximum number of attempts.'
    end
  where j.status = 'processing'
    and j.lease_expires_at is not null
    and j.lease_expires_at < now();

  update public.heavy_media_jobs j
  set
    status = 'failed',
    finished_at = now(),
    worker_id = null,
    lease_expires_at = null,
    error_code = coalesce(
      nullif(j.error_code, ''),
      'MAX_ATTEMPTS_REACHED'
    ),
    error_message = coalesce(
      nullif(j.error_message, ''),
      'The heavy media job reached the maximum number of attempts.'
    )
  where j.status = 'queued'
    and j.attempt_count >= j.max_attempts;

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
      now() + make_interval(
        secs => p_lease_seconds
      ),
    started_at = now(),
    finished_at = null,
    error_code = null,
    error_message = null
  from next_job
  where j.id = next_job.id
  returning j.*;
end;
$$;

revoke all
on function public.guard_heavy_media_job_capacity()
from public, anon, authenticated;

grant execute
on function public.guard_heavy_media_job_capacity()
to service_role;

revoke all
on function public.claim_next_heavy_media_job(
  text,
  integer,
  text[]
)
from public, anon, authenticated;

grant execute
on function public.claim_next_heavy_media_job(
  text,
  integer,
  text[]
)
to service_role;
