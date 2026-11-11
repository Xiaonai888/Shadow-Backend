with checks as (
  select 'fast_videos_table'::text as check_name,
    to_regclass('public.fast_videos') is not null as ready
  union all
  select 'recycle_columns', (
    select count(*) = 6
    from pg_catalog.pg_attribute
    where attrelid = to_regclass('public.fast_videos')
      and attname in ('studio_state', 'studio_restore_status', 'studio_trashed_from', 'archived_at', 'deleted_at', 'purge_at')
      and attnum > 0 and not attisdropped
  )
  union all
  select 'state_constraint', exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = to_regclass('public.fast_videos')
      and conname = 'fast_videos_studio_state_check'
  )
  union all
  select 'summary_function', to_regprocedure('public.shadow_studio_me_summary(uuid)') is not null
  union all
  select 'recycle_function', to_regprocedure('public.shadow_studio_recycle_video(uuid,uuid,text)') is not null
  union all
  select 'purge_function', to_regprocedure('public.purge_shadow_studio_trash(integer)') is not null
  union all
  select 'pg_cron_extension', exists (
    select 1 from pg_catalog.pg_extension where extname = 'pg_cron'
  )
  union all
  select 'archive_index', to_regclass('public.fast_videos_studio_archive_idx') is not null
  union all
  select 'trash_index', to_regclass('public.fast_videos_studio_trash_idx') is not null
  union all
  select 'purge_index', to_regclass('public.fast_videos_studio_purge_idx') is not null
)
select check_name,
  case when ready then 'READY' else 'MISSING' end as status
from checks
order by check_name;
