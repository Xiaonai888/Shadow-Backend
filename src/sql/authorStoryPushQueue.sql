create extension if not exists pgcrypto;

create table if not exists public.author_story_push_jobs (
  id uuid primary key default gen_random_uuid(),
  notification_id text not null unique,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'sent', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  claim_token uuid,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists author_story_push_jobs_due_idx
  on public.author_story_push_jobs (next_attempt_at, created_at)
  where status = 'queued';

create index if not exists author_story_push_jobs_lease_idx
  on public.author_story_push_jobs (lease_until)
  where status = 'processing';

create index if not exists author_story_push_jobs_done_idx
  on public.author_story_push_jobs (updated_at)
  where status in ('sent', 'skipped');

alter table public.author_story_push_jobs enable row level security;
revoke all on public.author_story_push_jobs from anon, authenticated;
grant all on public.author_story_push_jobs to service_role;

create or replace function public.enqueue_author_story_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.type not in ('comment', 'unlock', 'gift') then
    return new;
  end if;

  if new.type = 'gift' and lower(coalesce(new.metadata->>'currency', '')) not in ('diamond', 'diamonds') then
    return new;
  end if;

  if nullif(trim(coalesce(new.author_user_id::text, '')), '') is null then
    return new;
  end if;

  insert into public.author_story_push_jobs (notification_id, payload)
  values (
    new.id::text,
    jsonb_build_object(
      'id', new.id,
      'author_user_id', new.author_user_id,
      'type', new.type,
      'title', new.title,
      'message', new.message,
      'target_url', new.target_url,
      'metadata', new.metadata
    )
  )
  on conflict (notification_id) do nothing;

  return new;
end;
$$;

drop trigger if exists author_story_push_on_insert on public.author_story_notifications;
create trigger author_story_push_on_insert
  after insert on public.author_story_notifications
  for each row execute function public.enqueue_author_story_push();

create or replace function public.claim_author_story_push_jobs(p_limit integer default 12)
returns setof public.author_story_push_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_limit is null or p_limit not between 1 and 20 then
    raise exception 'Invalid push batch size';
  end if;

  return query
  with claimed as (
    select j.id
    from public.author_story_push_jobs j
    where (j.status = 'queued' and j.next_attempt_at <= now())
       or (j.status = 'processing' and j.lease_until < now())
    order by j.created_at
    for update skip locked
    limit p_limit
  )
  update public.author_story_push_jobs j
     set status = 'processing',
         claim_token = gen_random_uuid(),
         lease_until = now() + interval '5 minutes',
         attempts = j.attempts + 1,
         updated_at = now()
    from claimed c
   where j.id = c.id
  returning j.*;
end;
$$;

create or replace function public.finish_author_story_push_jobs(p_results jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) > 20 then
    raise exception 'Invalid push result batch';
  end if;

  with results as (
    select * from jsonb_to_recordset(p_results) as r(
      id uuid,
      claim_token uuid,
      outcome text,
      error text
    )
    where outcome in ('sent', 'skipped', 'retry')
  )
  update public.author_story_push_jobs j
     set status = case
           when r.outcome = 'sent' then 'sent'
           when r.outcome = 'skipped' then 'skipped'
           else 'queued'
         end,
         next_attempt_at = case
           when r.outcome = 'retry' then now() + make_interval(
             secs => least(1800, (10 * power(2, least(j.attempts, 8)))::integer)
           )
           else j.next_attempt_at
         end,
         last_error = case when r.outcome = 'retry' then left(coalesce(r.error, ''), 300) else null end,
         lease_until = null,
         claim_token = null,
         updated_at = now()
    from results r
   where j.id = r.id
     and j.claim_token = r.claim_token
     and j.status = 'processing'
     and j.lease_until > now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.enqueue_author_story_push() from public, anon, authenticated;
revoke execute on function public.claim_author_story_push_jobs(integer) from public, anon, authenticated;
revoke execute on function public.finish_author_story_push_jobs(jsonb) from public, anon, authenticated;
grant execute on function public.claim_author_story_push_jobs(integer) to service_role;
grant execute on function public.finish_author_story_push_jobs(jsonb) to service_role;
