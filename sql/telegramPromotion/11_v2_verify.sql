with expected(name,kind) as (
  values
    ('telegram_promotion_v2_message_meta','r'),
    ('telegram_promotion_v2_group_stories','r'),
    ('telegram_promotion_v2_update_groups','r'),
    ('telegram_promotion_v2_update_episodes','r'),
    ('telegram_promotion_v2_exposure_history','v'),
    ('telegram_promotion_v2_caption_history','v'),
    ('telegram_promotion_v2_update_totals','v')
), objects as (
  select e.name,e.kind,c.oid,c.relkind,c.relrowsecurity,c.reloptions
  from expected e
  left join pg_namespace n on n.nspname='public'
  left join pg_class c on c.relnamespace=n.oid and c.relname=e.name
)
select name as check_name,
       coalesce(relkind::text=kind
         and case when kind='r' then relrowsecurity else 'security_invoker=true'=any(reloptions) end
         and has_table_privilege('service_role',oid,'SELECT')
         and not has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE')
         and not has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE'),false) as ok
from objects
union all
select 'existing_queue',to_regclass('public.telegram_promotion_queue') is not null
union all
select 'existing_events',to_regclass('public.telegram_promotion_events') is not null
union all
select 'existing_settings',to_regclass('public.telegram_promotion_settings') is not null
order by check_name;
