create or replace function public.prepare_story_episode_push_batch()
returns table(job_id uuid, batch_id uuid, recipient_count integer, is_done boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.story_episode_push_jobs%rowtype;
  v_users uuid[];
  v_next uuid;
  v_count integer;
  v_batch_id uuid;
  v_batch_index integer;
  v_done boolean;
  v_episode_status text;
  v_episode_deleted_at timestamptz;
  v_episode_published_at timestamptz;
  v_story_status text;
  v_story_deleted_at timestamptz;
begin
  select j.* into v_job
  from public.story_episode_push_jobs j
  where j.status in ('queued', 'processing')
    and j.available_at <= now()
    and j.subscribers_prepared = false
  order by j.available_at, j.created_at
  for update of j skip locked
  limit 1;

  if not found then
    return;
  end if;

  select e.status, e.deleted_at, e.published_at, s.status, s.deleted_at
  into v_episode_status, v_episode_deleted_at, v_episode_published_at,
       v_story_status, v_story_deleted_at
  from public.episodes e
  join public.stories s on s.id = e.story_id
  where e.id = v_job.episode_id and e.story_id = v_job.story_id;

  if not found or v_episode_deleted_at is not null or v_story_deleted_at is not null then
    update public.story_episode_push_jobs j
    set status = 'cancelled', updated_at = now(), completed_at = now()
    where j.id = v_job.id;
    update public.story_episode_push_batches b
    set status = 'cancelled', updated_at = now()
    where b.job_id = v_job.id and b.status = 'queued';
    return;
  end if;

  if v_episode_status is distinct from 'published'
     or v_story_status is distinct from 'published'
     or v_episode_published_at is null
     or v_episode_published_at > now() then
    update public.story_episode_push_jobs j
    set available_at = now() + interval '5 minutes', updated_at = now()
    where j.id = v_job.id;
    return;
  end if;

  select coalesce(array_agg(x.user_id order by x.user_id), '{}'::uuid[])
  into v_users
  from (
    select r.user_id
    from public.reader_subscriptions r
    where r.story_id = v_job.story_id
      and r.created_at <= v_job.published_at
      and (v_job.subscriber_cursor is null or r.user_id > v_job.subscriber_cursor)
    order by r.user_id
    limit 2000
  ) x;

  v_count := cardinality(v_users);
  v_done := v_count < 2000;
  v_next := case when v_count > 0 then v_users[v_count] else v_job.subscriber_cursor end;
  v_batch_id := null;

  if v_count > 0 then
    select coalesce(max(b.batch_index), -1) + 1 into v_batch_index
    from public.story_episode_push_batches b
    where b.job_id = v_job.id;

    insert into public.story_episode_push_batches (job_id, batch_index, recipient_user_ids)
    values (v_job.id, v_batch_index, v_users)
    returning id into v_batch_id;
  end if;

  update public.story_episode_push_jobs j
  set status = 'processing',
      subscriber_cursor = v_next,
      prepared_count = j.prepared_count + v_count,
      subscribers_prepared = v_done,
      updated_at = now()
  where j.id = v_job.id;

  return query select v_job.id, v_batch_id, v_count, v_done;
end;
$$;

create or replace function public.claim_story_episode_push_batch(
  p_lease_seconds integer default 120
)
returns setof public.story_episode_push_batches
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_lease_seconds not between 30 and 600 then
    raise exception 'Invalid lease duration';
  end if;

  update public.story_episode_push_batches b
  set status = 'failed', updated_at = now(), last_error = 'Maximum attempts exceeded'
  where b.attempts >= 8
    and (b.status = 'queued' or (b.status = 'processing' and b.lease_expires_at < now()));

  update public.story_episode_push_jobs j
  set status = case
        when exists (
          select 1 from public.story_episode_push_batches b
          where b.job_id = j.id and b.status = 'failed'
        ) then 'failed' else 'completed' end,
      sent_count = (
        select coalesce(sum(b.accepted_count), 0)::integer
        from public.story_episode_push_batches b
        where b.job_id = j.id and b.status = 'sent'
      ),
      completed_at = now(),
      updated_at = now()
  where j.status = 'processing'
    and j.subscribers_prepared = true
    and not exists (
      select 1 from public.story_episode_push_batches b
      where b.job_id = j.id and b.status in ('queued', 'processing')
    );

  return query
  with next_batch as (
    select b.id
    from public.story_episode_push_batches b
    join public.story_episode_push_jobs j on j.id = b.job_id
    where j.status in ('queued', 'processing')
      and b.attempts < 8
      and b.next_attempt_at <= now()
      and (b.status = 'queued' or
           (b.status = 'processing' and b.lease_expires_at < now()))
    order by b.created_at
    for update of b skip locked
    limit 1
  )
  update public.story_episode_push_batches b
  set status = 'processing',
      attempts = b.attempts + 1,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  from next_batch
  where b.id = next_batch.id
  returning b.*;
end;
$$;

create or replace function public.eligible_story_episode_push_users(p_batch_id uuid)
returns uuid[]
language sql
security definer
set search_path = public
as $$
  select coalesce(array_agg(r.user_id order by r.user_id), '{}'::uuid[])
  from public.story_episode_push_batches b
  join public.story_episode_push_jobs j on j.id = b.job_id
  join public.episodes e on e.id = j.episode_id and e.story_id = j.story_id
  join public.stories s on s.id = j.story_id
  join public.reader_subscriptions r
    on r.story_id = j.story_id and r.user_id = any(b.recipient_user_ids)
  where b.id = p_batch_id
    and b.status = 'processing'
    and j.status = 'processing'
    and r.created_at <= j.published_at
    and e.status = 'published'
    and e.deleted_at is null
    and e.published_at <= now()
    and s.status = 'published'
    and s.deleted_at is null;
$$;

create or replace function public.finish_story_episode_push_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows bigint := 0;
begin
  update public.story_episode_push_jobs j
  set status = case
        when exists (
          select 1 from public.story_episode_push_batches b
          where b.job_id = j.id and b.status = 'failed'
        ) then 'failed'
        else 'completed'
      end,
      sent_count = (
        select coalesce(sum(b.accepted_count), 0)::integer
        from public.story_episode_push_batches b
        where b.job_id = j.id and b.status = 'sent'
      ),
      completed_at = now(),
      lease_expires_at = null,
      worker_id = null,
      updated_at = now()
  where j.id = p_job_id
    and j.status = 'processing'
    and j.subscribers_prepared = true
    and not exists (
      select 1 from public.story_episode_push_batches b
      where b.job_id = j.id
        and b.status in ('queued', 'processing')
    );

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function public.prepare_story_episode_push_batch() from public, anon, authenticated;
revoke execute on function public.claim_story_episode_push_batch(integer) from public, anon, authenticated;
revoke execute on function public.eligible_story_episode_push_users(uuid) from public, anon, authenticated;
revoke execute on function public.finish_story_episode_push_job(uuid) from public, anon, authenticated;

grant execute on function public.prepare_story_episode_push_batch() to service_role;
grant execute on function public.claim_story_episode_push_batch(integer) to service_role;
grant execute on function public.eligible_story_episode_push_users(uuid) to service_role;
grant execute on function public.finish_story_episode_push_job(uuid) to service_role;
