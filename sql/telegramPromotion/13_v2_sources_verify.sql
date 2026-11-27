with signatures(signature) as (values
 ('public.telegram_promotion_v2_candidate_page(text,text,text,integer)'),
 ('public.telegram_promotion_v2_manga_pages(uuid)')
), checks as (
 select signature,to_regprocedure(signature) as oid from signatures
)
select signature as check_name,coalesce(oid is not null and has_function_privilege('service_role',oid,'EXECUTE') and not has_function_privilege('anon',oid,'EXECUTE') and not has_function_privilege('authenticated',oid,'EXECUTE'),false) as ok from checks
union all
select 'candidate_page_shape',jsonb_typeof(public.telegram_promotion_v2_candidate_page('km','night','verify',0)->'candidates')='array'
union all
select 'empty_manga_shape',public.telegram_promotion_v2_manga_pages(null)='[]'::jsonb;
