create or replace function public.get_story_episode_push_next_due_at()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select min(t.due_at)
  from (
    select min(j.available_at) as due_at
    from public.story_episode_push_jobs j
    where j.status in ('queued', 'processing')
      and j.subscribers_prepared = false

    union all

    select min(b.next_attempt_at) as due_at
    from public.story_episode_push_batches b
    join public.story_episode_push_jobs j on j.id = b.job_id
    where b.status = 'queued'
      and b.attempts < 8
      and j.status in ('queued', 'processing')

    union all

    select min(greatest(b.next_attempt_at, coalesce(b.lease_expires_at, now()))) as due_at
    from public.story_episode_push_batches b
    join public.story_episode_push_jobs j on j.id = b.job_id
    where b.status = 'processing'
      and b.attempts < 8
      and j.status in ('queued', 'processing')
  ) t;
$$;

revoke execute on function public.get_story_episode_push_next_due_at()
from public, anon, authenticated;

grant execute on function public.get_story_episode_push_next_due_at()
to service_role;
