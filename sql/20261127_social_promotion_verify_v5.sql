begin transaction read only;

with expected(name) as (values
 ('social_media_connections'),('social_promotion_rules'),('social_media_jobs'),('social_media_job_items')
)
select 'table_security' as check_group,e.name as name,
 coalesce(c.relrowsecurity,false) and not coalesce(has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE'),false)
 and not coalesce(has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'),false)
 and coalesce(has_table_privilege('service_role',c.oid,'SELECT'),false) as passed
from expected e left join pg_namespace n on n.nspname='public'
left join pg_class c on c.relnamespace=n.oid and c.relname=e.name;

with expected(signature) as (values
 ('public.shadow_smart_content_candidate_page_v1(text,text,text,integer,text,uuid[],uuid[],text[])'),
 ('public.social_promotion_enqueue_v2(uuid,timestamptz,timestamptz,text,jsonb,text)'),
 ('public.social_promotion_history_v2(uuid,text,uuid[])'),
 ('public.social_promotion_claim_v3()'),
 ('public.social_promotion_worker_context_v3(uuid,uuid)'),
 ('public.social_promotion_finish_v3(uuid,uuid,text,text,text)'),
 ('public.social_promotion_fresh_candidate_v4(uuid,uuid,text,boolean)'),
 ('public.social_promotion_updates_v4(uuid,timestamptz,timestamptz,integer)'),
 ('public.social_promotion_poll_v5(jsonb)')
), resolved as (select signature,to_regprocedure(signature) as routine from expected)
select 'rpc_security' as check_group,signature as name,
 routine is not null and coalesce(has_function_privilege('service_role',routine,'EXECUTE'),false)
 and not coalesce(has_function_privilege('anon',routine,'EXECUTE'),false)
 and not coalesce(has_function_privilege('authenticated',routine,'EXECUTE'),false) as passed
from resolved;

with expected(relation,name) as (values
 ('social_media_connections','social_media_connections_platform_check'),
 ('social_promotion_rules','social_promotion_rules_language_v2'),
 ('social_promotion_rules','social_promotion_rules_admin_short_v2'),
 ('social_media_jobs','social_media_jobs_admin_short_v2')
)
select 'constraint' as check_group,e.name,exists(select 1 from pg_constraint c where c.conrelid=to_regclass('public.'||e.relation) and c.conname=e.name and c.convalidated) as passed from expected e;

select 'trigger' as check_group,'social_promotion_account_cap_v5' as name,
 exists(select 1 from pg_trigger where tgrelid=to_regclass('public.social_media_jobs') and tgname='social_promotion_account_cap_v5' and tgenabled in ('O','A')) as passed;

rollback;
