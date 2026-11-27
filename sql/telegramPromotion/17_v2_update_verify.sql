with expected(signature) as (
  values
    ('public.telegram_promotion_v2_enqueue_update(text,uuid,jsonb)'),
    ('public.telegram_promotion_v2_finish_update(uuid,integer,text,integer,text,bigint[],text,integer)'),
    ('public.telegram_promotion_v2_claim_edit(text)'),
    ('public.telegram_promotion_v2_finish_edit(uuid,uuid,text,text,integer)'),
    ('public.telegram_promotion_v2_next_edit_due(text)')
), resolved as (
  select signature,to_regprocedure(signature) as oid from expected
)
select signature as check_name,coalesce(has_function_privilege('service_role',oid,'EXECUTE') and not has_function_privilege('anon',oid,'EXECUTE') and not has_function_privilege('authenticated',oid,'EXECUTE'),false) as ok from resolved
union all
select 'edit_claim_id',exists(select 1 from information_schema.columns where table_schema='public' and table_name='telegram_promotion_v2_update_groups' and column_name='edit_claim_id' and data_type='uuid')
union all
select 'edit_claim_revision',exists(select 1 from information_schema.columns where table_schema='public' and table_name='telegram_promotion_v2_update_groups' and column_name='edit_claim_revision' and data_type='integer')
order by check_name;
