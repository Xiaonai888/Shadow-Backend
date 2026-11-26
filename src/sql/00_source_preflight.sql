select 'column' as section, table_name||'.'||column_name as name, data_type as details
from information_schema.columns
where table_schema='public' and table_name in ('stories','episodes','author_pages','reader_presence','users') and (
 column_name in ('id','user_id','author_id','story_id','title','content','story_language','story_type','story_status','status','cover_url','deleted_at','is_adult','is_shadow_exclusive','exclusive_status','admin_visibility_status','ranking_visibility_status','published_at','first_published_at','scheduled_at','episode_number','page_name','page_username')
 or column_name ~* '(last.*(active|seen|login|heartbeat)|active.*at|presence|activity)'
)
union all
select 'index',tablename||'.'||indexname,indexdef from pg_indexes where schemaname='public' and tablename in ('episodes','stories','reader_presence','author_pages') and indexdef ~* '(first_published_at|author_id|story_id|last_active|last_seen|user_id)'
union all
select 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and (p.proname in ('get_public_story_updates','get_trending_story_pool_v1','upsert_reader_presence_heartbeat','touch_reader_presence_with_country','smart_ad_episode_summaries_v1','get_story_episode_push_next_due_at') or p.proname ~* '(publish.*schedul|schedul.*publish)')
union all
select 'trigger',t.tgname,pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='episodes' and not t.tgisinternal
order by section,name;
