select 'events_table' as check_name,
  case when pg_catalog.to_regclass('public.reader_activity_events') is not null then 'OK' else 'MISSING' end as status
union all
select 'summaries_table',
  case when pg_catalog.to_regclass('public.reader_activity_summaries') is not null then 'OK' else 'MISSING' end
union all
select 'daily_maintenance',
  case when pg_catalog.to_regprocedure('public.maintain_reader_activity_history(integer)') is not null then 'OK' else 'MISSING' end
union all
select 'week_month_rollup',
  case when pg_catalog.to_regprocedure('public.rollup_reader_activity_summaries(integer)') is not null then 'OK' else 'MISSING' end
union all
select 'cron_extension',
  case when exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then 'ENABLED' else 'NOT_ENABLED' end
union all
select 'activity_triggers',
  case when (select count(*) from pg_catalog.pg_trigger
    where tgname in (
      'reader_activity_story_reactions_trigger',
      'reader_activity_episode_reactions_trigger',
      'reader_activity_saved_posts_trigger',
      'reader_activity_comments_trigger',
      'reader_activity_reading_progress_trigger',
      'reader_activity_echo_capture_trigger',
      'reader_activity_unlock_capture_trigger',
      'reader_activity_gift_capture_trigger'
    ) and tgisinternal is false) = 8 then 'OK' else 'CHECK' end
union all
select 'security_triggers',
  case when (select count(*) from pg_catalog.pg_trigger
    where tgname in (
      'reader_activity_session_created_trigger',
      'reader_activity_session_revoked_trigger',
      'reader_activity_credentials_trigger',
      'reader_activity_security_settings_trigger'
    ) and tgisinternal is false) = 4 then 'OK' else 'CHECK' end;
