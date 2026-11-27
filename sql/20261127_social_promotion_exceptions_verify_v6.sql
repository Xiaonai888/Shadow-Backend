begin transaction read only;
with checks as (
  select 'table_security' as name,coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.social_promotion_exceptions')),false)
    and not has_table_privilege('anon','public.social_promotion_exceptions','SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated','public.social_promotion_exceptions','SELECT,INSERT,UPDATE,DELETE')
    and has_table_privilege('service_role','public.social_promotion_exceptions','SELECT') as passed
  union all select 'job_item_guard',exists(select 1 from pg_trigger where tgrelid=to_regclass('public.social_media_job_items') and tgname='social_promotion_exception_item_guard_v6' and tgenabled in ('O','A'))
  union all select 'worker_context_guard',position('social_promotion_story_blocked_v6' in pg_get_functiondef('public.social_promotion_worker_context_v3(uuid,uuid)'::regprocedure))>0
  union all select 'empty_allow_list',public.social_promotion_allowed_stories_v6('{}'::uuid[])='[]'::jsonb
), signatures(signature) as (values
  ('public.social_promotion_language_v6(text)'),('public.social_promotion_story_blocked_v6(uuid)'),('public.social_promotion_allowed_stories_v6(uuid[])'),('public.social_promotion_exception_list_v6(text,text,text,integer,boolean)'),('public.social_promotion_exception_change_v6(text,uuid,boolean)'),('public.social_promotion_exception_item_guard_v6()'),('public.social_promotion_worker_context_v3(uuid,uuid)')
), security as (
  select signature as name,has_function_privilege('service_role',signature,'EXECUTE') and not has_function_privilege('anon',signature,'EXECUTE') and not has_function_privilege('authenticated',signature,'EXECUTE') as passed from signatures
), languages(language) as (values ('km'),('en'),('zh'),('ja'),('ko')),
responses as materialized (
  select language,public.social_promotion_exception_list_v6('story',language,'',1,false) as response,public.social_promotion_exception_list_v6('story',language,'',1,true) as blocked from languages
), language_checks as (
  select 'language_'||language as name,jsonb_array_length(response->'items')<=10 and jsonb_array_length(blocked->'items')<=10 and not exists(select 1 from jsonb_array_elements((response->'items')||(blocked->'items')) item where item->>'language' is distinct from language) as passed from responses
), author_response as materialized (
  select public.social_promotion_exception_list_v6('author','all','',1,false) as response
), author_check as (
  select 'authors_global' as name,jsonb_array_length(response->'items')<=10 and not exists(select 1 from jsonb_array_elements(response->'items') item where item->>'language' is not null) as passed from author_response
)
select name,case when passed is true then 'PASS' else 'FAIL' end as result from (select * from checks union all select * from security union all select * from language_checks union all select * from author_check) all_checks order by name;
rollback;
