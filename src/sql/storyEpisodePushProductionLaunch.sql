begin;

create table if not exists public.story_episode_push_launch_checkpoint (
  id boolean primary key default true check (id),
  launched_at timestamptz not null default now(),
  cancelled_jobs integer not null default 0,
  cancelled_batches integer not null default 0
);

alter table public.story_episode_push_launch_checkpoint enable row level security;
revoke all on public.story_episode_push_launch_checkpoint from anon, authenticated;
grant select on public.story_episode_push_launch_checkpoint to service_role;

do $$
declare
  v_launch_at timestamptz := now();
  v_jobs integer := 0;
  v_batches integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('shadow_story_episode_push_production_launch'));

  if exists (select 1 from public.story_episode_push_launch_checkpoint where id = true) then
    raise notice 'Story episode push production launch already prepared; no changes made';
    return;
  end if;

  insert into public.story_episode_push_launch_checkpoint (id, launched_at)
  values (true, v_launch_at);

  update public.story_episode_push_jobs
  set status = 'cancelled',
      completed_at = v_launch_at,
      updated_at = v_launch_at,
      lease_expires_at = null,
      worker_id = null,
      last_error = 'Pre-launch pending notification skipped'
  where status in ('queued', 'processing')
    and created_at <= v_launch_at;

  get diagnostics v_jobs = row_count;

  update public.story_episode_push_batches b
  set status = 'cancelled',
      lease_expires_at = null,
      updated_at = v_launch_at,
      last_error = 'Pre-launch pending notification skipped'
  from public.story_episode_push_jobs j
  where j.id = b.job_id
    and j.status = 'cancelled'
    and j.completed_at = v_launch_at
    and j.last_error = 'Pre-launch pending notification skipped'
    and b.status in ('queued', 'processing');

  get diagnostics v_batches = row_count;

  update public.story_episode_push_launch_checkpoint
  set cancelled_jobs = v_jobs,
      cancelled_batches = v_batches
  where id = true;
end;
$$;

commit;

select launched_at, cancelled_jobs, cancelled_batches
from public.story_episode_push_launch_checkpoint
where id = true;
