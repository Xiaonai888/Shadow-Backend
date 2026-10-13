with job_stats as (
  select
    count(*) as total_jobs,
    count(*) filter (where status = 'queued') as queued_jobs,
    count(*) filter (where status = 'processing') as processing_jobs,
    count(*) filter (where status = 'completed') as completed_jobs,
    count(*) filter (where status = 'failed') as failed_jobs,
    count(*) filter (where status = 'cancelled') as cancelled_jobs,
    count(*) filter (
      where status in ('queued','processing')
        and subscribers_prepared = false
        and available_at <= now()
    ) as ready_to_prepare,
    count(*) filter (
      where status in ('queued','processing')
        and subscribers_prepared = false
        and available_at > now()
    ) as waiting_to_prepare,
    count(*) filter (
      where status in ('queued','processing')
        and created_at < now() - interval '24 hours'
    ) as old_pending_jobs,
    coalesce(sum(prepared_count),0)::bigint as prepared_recipients,
    coalesce(sum(sent_count),0)::bigint as reported_sent_recipients
  from public.story_episode_push_jobs
), batch_stats as (
  select
    count(*) as total_batches,
    count(*) filter (where status = 'queued') as queued_batches,
    count(*) filter (where status = 'processing') as processing_batches,
    count(*) filter (where status = 'sent') as sent_batches,
    count(*) filter (where status = 'failed') as failed_batches,
    count(*) filter (
      where status = 'queued'
        and next_attempt_at <= now()
    ) as ready_to_retry,
    count(*) filter (
      where status = 'queued'
        and next_attempt_at > now()
    ) as waiting_to_retry,
    count(*) filter (
      where status = 'processing'
        and lease_expires_at < now()
    ) as expired_batch_leases,
    count(*) filter (
      where status = 'processing'
        and lease_expires_at is null
    ) as missing_batch_leases,
    count(*) filter (
      where status in ('queued','processing')
        and created_at < now() - interval '24 hours'
    ) as old_pending_batches,
    count(*) filter (
      where status = 'failed'
        and attempts >= 8
    ) as exhausted_batches
  from public.story_episode_push_batches
)
select 'jobs_total' as metric, total_jobs as value from job_stats
union all select 'jobs_queued', queued_jobs from job_stats
union all select 'jobs_processing', processing_jobs from job_stats
union all select 'jobs_completed', completed_jobs from job_stats
union all select 'jobs_failed', failed_jobs from job_stats
union all select 'jobs_cancelled', cancelled_jobs from job_stats
union all select 'jobs_ready_to_prepare', ready_to_prepare from job_stats
union all select 'jobs_waiting_to_prepare', waiting_to_prepare from job_stats
union all select 'jobs_pending_over_24h', old_pending_jobs from job_stats
union all select 'recipient_ids_prepared_total', prepared_recipients from job_stats
union all select 'recipients_reported_sent_total', reported_sent_recipients from job_stats
union all select 'batches_total', total_batches from batch_stats
union all select 'batches_queued', queued_batches from batch_stats
union all select 'batches_processing', processing_batches from batch_stats
union all select 'batches_sent', sent_batches from batch_stats
union all select 'batches_failed', failed_batches from batch_stats
union all select 'batches_ready_to_retry', ready_to_retry from batch_stats
union all select 'batches_waiting_to_retry', waiting_to_retry from batch_stats
union all select 'batches_expired_leases', expired_batch_leases from batch_stats
union all select 'batches_missing_leases', missing_batch_leases from batch_stats
union all select 'batches_pending_over_24h', old_pending_batches from batch_stats
union all select 'batches_exhausted', exhausted_batches from batch_stats
order by metric;
