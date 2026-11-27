with expected_rel(name,kind) as (
  values
  ('telegram_promotion_settings','r'),
  ('telegram_promotion_queue','r'),
  ('telegram_promotion_events','r'),
  ('telegram_promotion_photo_cache','r'),
  ('telegram_promotion_recovery','r'),
  ('telegram_promotion_v2_message_meta','r'),
  ('telegram_promotion_v2_group_stories','r'),
  ('telegram_promotion_v2_update_groups','r'),
  ('telegram_promotion_v2_update_episodes','r'),
  ('telegram_promotion_v2_story_completion','r'),
  ('telegram_promotion_v2_exposure_history','v'),
  ('telegram_promotion_v2_caption_history','v'),
  ('telegram_promotion_v2_update_totals','v')
), rels as (
  select e.*,c.oid,c.relkind,c.relrowsecurity,c.reloptions
  from expected_rel e left join pg_catalog.pg_class c
  on c.oid=to_regclass('public.'||e.name)
), expected_rpc(signature) as (
  values
  ('telegram_promotion_enqueue_v1(text,text,text,uuid,uuid,uuid,jsonb,timestamptz,timestamptz)'),
  ('telegram_promotion_claim_v1(text)'),
  ('telegram_promotion_finish_v1(uuid,integer,text,text,bigint,integer)'),
  ('telegram_promotion_next_due_v1()'),
  ('telegram_promotion_runtime_due_v1(text)'),
  ('telegram_promotion_reconcile_v1(text,timestamptz,timestamptz,timestamptz,uuid,integer)'),
  ('telegram_promotion_job_context_v1(uuid,uuid,text)'),
  ('telegram_promotion_v2_candidate_page(text,text,text,integer)'),
  ('telegram_promotion_v2_manga_pages(uuid)'),
  ('telegram_promotion_v2_enqueue_optional(text,text,text,text,text,jsonb,jsonb,timestamptz,timestamptz,integer)'),
  ('telegram_promotion_v2_finish(uuid,integer,text,text,bigint[],text,integer)'),
  ('telegram_promotion_v2_enqueue_update(text,uuid,jsonb)'),
  ('telegram_promotion_v2_finish_update(uuid,integer,text,integer,text,bigint[],text,integer)'),
  ('telegram_promotion_v2_claim_edit(text)'),
  ('telegram_promotion_v2_finish_edit(uuid,uuid,text,text,integer)'),
  ('telegram_promotion_v2_next_edit_due(text)'),
  ('telegram_promotion_v2_story_status(uuid,uuid)'),
  ('telegram_promotion_v2_slot_context(text,text)'),
  ('telegram_promotion_v2_completion_due(text)'),
  ('telegram_promotion_v2_enqueue_completion(text,uuid,uuid,timestamptz,jsonb)'),
  ('telegram_promotion_v2_completion_valid(uuid)')
), rpcs as (
  select signature,to_regprocedure('public.'||signature)::oid as oid from expected_rpc
), checks as (
  select 'relation'::text as category,name as check_name,
    coalesce(relkind::text=kind and
    case when kind='r' then relrowsecurity else 'security_invoker=true'=any(reloptions) end
    and has_table_privilege('service_role',oid,'SELECT')
    and not has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE'),false) as ok,
    case when oid is null then 'missing' else 'check type, RLS/security_invoker and grants' end as detail from rels
  union all
  select 'rpc',signature,coalesce(has_function_privilege('service_role',oid,'EXECUTE') and not has_function_privilege('anon',oid,'EXECUTE') and not has_function_privilege('authenticated',oid,'EXECUTE'),false),case when oid is null then 'missing' else 'check execute grants' end from rpcs
  union all
  select 'trigger',x.name,exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid=to_regclass('public.'||x.relation_name) and t.tgname=x.name and not t.tgisinternal and t.tgenabled in ('O','A')),'check enabled trigger' from (values ('episodes','telegram_promotion_capture_episode'),('stories','telegram_promotion_v2_capture_story_completion')) x(relation_name,name)
  union all
  select 'column',x.name,exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=to_regclass('public.telegram_promotion_v2_update_groups') and a.attname=x.name and a.attnum>0 and not a.attisdropped),'check edit claim column' from (values ('edit_claim_id'),('edit_claim_revision')) x(name)
  union all
  select 'constraint','queue accepts solo and group',exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=to_regclass('public.telegram_promotion_queue') and c.conname='telegram_promotion_queue_kind_check' and c.convalidated and pg_get_constraintdef(c.oid) like '%''solo''%' and pg_get_constraintdef(c.oid) like '%''group''%'),'check V2 queue kinds'
)
select * from checks order by category,check_name;

with bounds as (
  select date_trunc('day',now() at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh' as day_start
), stats as (
  select s.language,s.enabled,s.channel_id is not null as channel_configured,s.enabled_at is not null as enabled_at_configured,s.gap_seconds,
    (select count(*) from public.telegram_promotion_queue q where q.language=s.language and q.status in ('ready','sending') and not exists(select 1 from public.telegram_promotion_v2_message_meta m where m.queue_id=q.id)) as legacy_active_jobs,
    (select count(*) from public.telegram_promotion_queue q where q.language=s.language and q.status='uncertain' and q.updated_at>=b.day_start) as uncertain_today,
    (select count(*) from public.telegram_promotion_events e where e.language=s.language and e.state='pending' and e.due_at<=now()) as due_pending_events,
    (select count(*) from public.telegram_promotion_queue q where q.language=s.language and q.kind='update' and not exists(select 1 from public.telegram_promotion_v2_message_meta m where m.queue_id=q.id) and (q.created_at>=b.day_start or exists(select 1 from public.episodes e where e.id=q.episode_id and e.first_published_at>=b.day_start))) as legacy_updates_today,
    (select count(*) from public.telegram_promotion_queue q where q.language=s.language and q.status in ('ready','sending') and exists(select 1 from public.telegram_promotion_v2_message_meta m where m.queue_id=q.id)) as v2_active_jobs
  from public.telegram_promotion_settings s cross join bounds b where s.language in ('km','en')
)
select *,case when not enabled then 'DISABLED' when not channel_configured or not enabled_at_configured then 'CHECK_CHANNEL' when legacy_active_jobs>0 or due_pending_events>0 then 'DRAIN_PENDING' when uncertain_today>0 then 'REVIEW_UNCERTAIN' when legacy_updates_today>0 then 'CUTOVER_NEXT_LOCAL_DAY' when v2_active_jobs>0 then 'REVIEW_V2_ACTIVE' else 'READY_FOR_ENV_CHECK' end as cutover_status
from stats order by language;
