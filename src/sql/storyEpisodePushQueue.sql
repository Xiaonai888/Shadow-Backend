create extension if not exists pgcrypto;

create table if not exists public.story_episode_push_jobs (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  episode_id uuid not null unique references public.episodes(id) on delete cascade,
  published_at timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  subscriber_cursor uuid,
  subscribers_prepared boolean not null default false,
  prepared_count integer not null default 0 check (prepared_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 10 check (max_attempts between 1 and 100),
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  worker_id text,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.story_episode_push_batches (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.story_episode_push_jobs(id) on delete cascade,
  batch_index integer not null check (batch_index >= 0),
  recipient_user_ids uuid[] not null
    check (cardinality(recipient_user_ids) between 1 and 2000),
  idempotency_key uuid not null default gen_random_uuid() unique,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  onesignal_notification_id text,
  accepted_count integer not null default 0 check (accepted_count >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, batch_index)
);

create index if not exists story_episode_push_jobs_due_idx
  on public.story_episode_push_jobs (available_at, created_at)
  where status in ('queued', 'processing');

create index if not exists story_episode_push_batches_due_idx
  on public.story_episode_push_batches (job_id, status, next_attempt_at);

create index if not exists reader_subscriptions_push_lookup_idx
  on public.reader_subscriptions (story_id, user_id);

alter table public.story_episode_push_jobs enable row level security;
alter table public.story_episode_push_batches enable row level security;

revoke all on public.story_episode_push_jobs from anon, authenticated;
revoke all on public.story_episode_push_batches from anon, authenticated;
grant all on public.story_episode_push_jobs to service_role;
grant all on public.story_episode_push_batches to service_role;

create or replace function public.enqueue_story_episode_push(
  p_story_id uuid,
  p_episode_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  insert into public.story_episode_push_jobs (
    story_id,
    episode_id,
    published_at
  )
  select e.story_id, e.id, e.published_at
  from public.episodes e
  join public.stories s on s.id = e.story_id
  where e.id = p_episode_id
    and e.story_id = p_story_id
    and e.status = 'published'
    and e.published_at is not null
    and e.published_at <= now()
    and e.deleted_at is null
    and s.status = 'published'
    and s.deleted_at is null
  on conflict (episode_id) do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select j.id into v_job_id
    from public.story_episode_push_jobs j
    where j.episode_id = p_episode_id
      and j.story_id = p_story_id;
  end if;

  return v_job_id;
end;
$$;

create or replace function public.claim_story_episode_push_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.story_episode_push_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_worker_id), '') is null
     or char_length(p_worker_id) > 100 then
    raise exception 'Invalid worker ID';
  end if;

  if p_lease_seconds not between 30 and 3600 then
    raise exception 'Invalid lease duration';
  end if;

  return query
  with next_job as (
    select j.id
    from public.story_episode_push_jobs j
    where j.available_at <= now()
      and j.attempts < j.max_attempts
      and (
        j.status = 'queued'
        or (
          j.status = 'processing'
          and j.lease_expires_at <= now()
        )
      )
    order by j.available_at, j.created_at
    for update skip locked
    limit 1
  )
  update public.story_episode_push_jobs j
  set status = 'processing',
      worker_id = trim(p_worker_id),
      attempts = j.attempts + 1,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  from next_job
  where j.id = next_job.id
  returning j.*;
end;
$$;

revoke execute on function public.enqueue_story_episode_push(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.claim_story_episode_push_job(text, integer)
  from public, anon, authenticated;

grant execute on function public.enqueue_story_episode_push(uuid, uuid)
  to service_role;
grant execute on function public.claim_story_episode_push_job(text, integer)
  to service_role;
