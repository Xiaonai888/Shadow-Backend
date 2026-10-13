with required(check_type, object_name, parent_table) as (
  values
    ('EXTENSION', 'pgcrypto', null::text),
    ('EXTENSION', 'pg_net', null::text),
    ('EXTENSION', 'pg_cron', null::text),
    ('TABLE', 'public.stories', null::text),
    ('TABLE', 'public.episodes', null::text),
    ('TABLE', 'public.reader_subscriptions', null::text),
    ('TABLE', 'public.story_episode_push_jobs', null::text),
    ('TABLE', 'public.story_episode_push_batches', null::text),
    ('FUNCTION', 'public.capture_story_episode_push()', null::text),
    ('FUNCTION', 'public.enqueue_story_episode_push(uuid,uuid)', null::text),
    ('FUNCTION', 'public.prepare_story_episode_push_batch()', null::text),
    ('FUNCTION', 'public.claim_story_episode_push_batch(integer)', null::text),
    ('FUNCTION', 'public.eligible_story_episode_push_users(uuid)', null::text),
    ('FUNCTION', 'public.finish_story_episode_push_job(uuid)', null::text),
    ('FUNCTION', 'public.wake_shadow_story_episode_push()', null::text),
    ('FUNCTION', 'public.resume_story_episode_push_after_story_publish()', null::text),
    ('FUNCTION', 'public.publish_due_shadow_story_episodes(integer)', null::text),
    ('TRIGGER', 'story_episode_push_after_insert', 'public.episodes'),
    ('TRIGGER', 'story_episode_push_after_publish', 'public.episodes'),
    ('TRIGGER', 'story_episode_push_story_publish_resume', 'public.stories'),
    ('TRIGGER', 'story_episode_push_wake_after_insert', 'public.story_episode_push_jobs'),
    ('TRIGGER', 'story_episode_push_wake_after_resume', 'public.story_episode_push_jobs')
),
checks as (
  select
    r.check_type,
    r.object_name,
    case
      when r.check_type = 'EXTENSION' then exists (
        select 1 from pg_catalog.pg_extension e where e.extname = r.object_name
      )
      when r.check_type = 'TABLE' then to_regclass(r.object_name) is not null
      when r.check_type = 'FUNCTION' then to_regprocedure(r.object_name) is not null
      when r.check_type = 'TRIGGER' then exists (
        select 1
        from pg_catalog.pg_trigger t
        where t.tgrelid = to_regclass(r.parent_table)
          and t.tgname = r.object_name
          and t.tgenabled in ('O', 'A')
          and not t.tgisinternal
      )
      else false
    end as ready
  from required r
),
operational as (
  select
    'CRON'::text as check_type,
    'shadow-story-scheduled-episode-release'::text as object_name,
    case
      when to_regclass('cron.job') is null then false
      else xpath_exists(
        '//row',
        query_to_xml(
          'select 1 as present from cron.job where jobname = ''shadow-story-scheduled-episode-release'' and active = true and schedule = ''* * * * *'' limit 1',
          true, false, ''
        )
      )
    end as ready
  union all
  select
    'VAULT',
    'story_episode_push_wake_token',
    case
      when to_regclass('vault.decrypted_secrets') is null then false
      else xpath_exists(
        '//row',
        query_to_xml(
          'select 1 as present from vault.decrypted_secrets where name = ''story_episode_push_wake_token'' and length(decrypted_secret) >= 32 limit 1',
          true, false, ''
        )
      )
    end
)
select
  check_type,
  object_name,
  case when ready then 'OK' else 'MISSING' end as result
from (
  select * from checks
  union all
  select * from operational
) audit
order by
  case when ready then 1 else 0 end,
  check_type,
  object_name;
