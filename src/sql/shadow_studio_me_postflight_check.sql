with state_counts as (
  select
    count(*) filter (where studio_state = 'active') as active_videos,
    count(*) filter (where studio_state = 'archived') as archived_videos,
    count(*) filter (where studio_state = 'trashed') as trashed_videos,
    count(*) filter (where studio_state in ('archived', 'trashed') and status <> 'draft') as hidden_videos_not_draft,
    count(*) filter (where studio_state = 'trashed' and purge_at <= now() - interval '2 hours') as overdue_trash,
    count(*) filter (where studio_state not in ('active', 'archived', 'trashed') or studio_state is null) as invalid_states
  from public.fast_videos
),
cron_check as (
  select count(*) as active_jobs
  from cron.job
  where jobname = 'shadow-studio-reel-trash-purge-30d'
    and active = true
    and schedule = '15 * * * *'
)
select
  state_counts.*,
  cron_check.active_jobs as scheduled_purge_jobs,
  to_regprocedure('public.shadow_studio_me_summary(uuid)') is not null as summary_rpc_installed,
  to_regprocedure('public.shadow_studio_recycle_video(uuid,uuid,text)') is not null as recycle_rpc_installed,
  to_regprocedure('public.purge_shadow_studio_trash(integer)') is not null as purge_rpc_installed,
  case
    when hidden_videos_not_draft = 0 and invalid_states = 0 and active_jobs = 1 and overdue_trash = 0
    then 'READY'
    else 'REVIEW_REQUIRED'
  end as verification_status
from state_counts cross join cron_check;
