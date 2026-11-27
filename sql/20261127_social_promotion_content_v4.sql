begin;

create or replace function public.social_promotion_updates_v4(p_rule_id uuid,p_revision timestamptz,p_slot timestamptz,p_limit integer default 30)
returns jsonb language sql stable security invoker set search_path='' as $$
with scope as (
 select r.*,date_trunc('day',p_slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh' as day_start
 from public.social_promotion_rules r join public.social_media_connections c on c.id=r.connection_id
 where r.id=p_rule_id and r.updated_at=p_revision and r.owner_type='admin' and r.owner_id='shadow' and r.enabled and r.source_topic='update'
 and c.owner_type='admin' and c.owner_id='shadow' and c.status='connected' and c.token_ciphertext is not null
 and (c.token_expires_at is null or c.token_expires_at>now()) and p_slot between now()-interval '15 minutes' and now()
 and p_limit between 1 and 30
), batch as materialized (
 select s.id as story_id,e.id as episode_id,e.first_published_at
 from scope r join public.episodes e on e.first_published_at>=r.day_start and e.first_published_at<r.day_start+interval '24 hours' and e.first_published_at<=now()
 join public.stories s on s.id=e.story_id join public.author_pages a on a.id=s.author_id
 left join public.reader_presence rp on rp.user_id=a.user_id
 where s.status='published' and s.deleted_at is null and s.is_adult is false and e.status='published' and e.deleted_at is null and e.is_adult is false
 and exists(select 1 from public.shadow_reader_visible_stories_v1 v where v.id=s.id)
 and coalesce(s.admin_visibility_status,'active') in ('','active') and coalesce(s.ranking_visibility_status,'visible')='visible'
 and (s.is_shadow_exclusive is not true or s.exclusive_status='approved') and a.status='active' and coalesce(a.ranking_visibility_status,'visible')='visible'
 and nullif(trim(s.cover_url),'') is not null and (e.published_at is null or e.published_at<=now()) and (e.scheduled_at is null or e.scheduled_at<=now())
 and (lower(s.story_status)='completed' or rp.last_activity_at between now()-interval '30 days' and now())
 and (case split_part(lower(replace(trim(s.story_language),'_','-')),'-',1) when 'kh' then 'km' when 'khmer' then 'km' when 'english' then 'en' when 'chinese' then 'zh' when 'jp' then 'ja' when 'japanese' then 'ja' when 'kr' then 'ko' when 'korean' then 'ko' else split_part(lower(replace(trim(s.story_language),'_','-')),'-',1) end)=r.language
 and (r.selection_mode='smart' or s.id::text=any(r.story_ids) or s.author_id::text=any(r.author_ids))
 and (cardinality(r.story_types)=0 or (case when lower(coalesce(s.story_type,'novel')) in ('short','short_story','short_novel') then 'novel' else lower(coalesce(s.story_type,'novel')) end)=any(r.story_types))
 and not exists(select 1 from public.social_media_jobs j left join public.social_media_job_items i on i.job_id=j.id
 where j.connection_id=r.connection_id and j.owner_type='admin' and j.owner_id='shadow' and j.status in ('queued','publishing','published','needs_review')
 and coalesce(i.episode_id::text,j.episode_id)=e.id::text and (j.status<>'published' or j.post_kind='update' or j.rule_revision is null))
 order by e.first_published_at desc,e.id limit 100
), summaries as (
 select * from public.smart_ad_episode_summaries_v1(array(select distinct story_id from batch))
), eligible as (
 select b.* from batch b join summaries x on x.story_id=b.story_id where x.published_episode_count>=5
 order by b.first_published_at desc,b.episode_id limit greatest(0,least(30,coalesce(p_limit,0)))
)
select coalesce(jsonb_agg(jsonb_build_object('story',jsonb_build_object('id',story_id),'episode',jsonb_build_object('id',episode_id)) order by first_published_at desc,episode_id),'[]'::jsonb) from eligible;
$$;

create or replace function public.social_promotion_fresh_candidate_v4(p_story_id uuid,p_episode_id uuid,p_topic text,p_preview boolean default false)
returns jsonb language sql stable security invoker set search_path='' as $$
with picked as materialized (
 select s.id,s.author_id,s.created_at,r.last_activity_at,coalesce(a.page_name,a.page_username,'') as author_name,e.id as episode_id
 from public.stories s join public.episodes e on e.story_id=s.id join public.author_pages a on a.id=s.author_id
 left join public.reader_presence r on r.user_id=a.user_id
 where s.id=p_story_id and e.id=p_episode_id and p_topic in ('solo','update','gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','night')
 and exists(select 1 from public.shadow_reader_visible_stories_v1 v where v.id=s.id)
 and s.status='published' and s.deleted_at is null and s.is_adult is false and e.status='published' and e.deleted_at is null and e.is_adult is false
 and coalesce(s.admin_visibility_status,'active') in ('','active') and coalesce(s.ranking_visibility_status,'visible')='visible'
 and (s.is_shadow_exclusive is not true or s.exclusive_status='approved') and a.status='active' and coalesce(a.ranking_visibility_status,'visible')='visible'
 and nullif(trim(s.cover_url),'') is not null and coalesce(e.first_published_at,e.published_at)<=now() and (e.published_at is null or e.published_at<=now()) and (e.scheduled_at is null or e.scheduled_at<=now())
 and (lower(s.story_status)='completed' or r.last_activity_at between now()-interval '30 days' and now())
), summaries as (
 select * from public.smart_ad_episode_summaries_v1(array(select id from picked))
), coverage as (
 select (now() at time zone 'Asia/Phnom_Penh')::date as day where p_topic in ('trending','night')
), activity as (
 select p.id,case when exists(select 1 from public.trending_story_daily_snapshots where snapshot_day=c.day) and exists(select 1 from public.trending_story_daily_snapshots where snapshot_day=c.day-7)
 then greatest(0,coalesce(n.total_views-w.total_views,case when p.created_at>=((c.day-6)::timestamp at time zone 'Asia/Phnom_Penh') then n.total_views end,0))::bigint
 else coalesce((select sum(d.episode_reads) from public.admin_story_reader_daily d where d.story_id=p.id and d.activity_day>=c.day-7 and d.activity_day<c.day),0)::bigint end as reads
 from picked p cross join coverage c left join public.trending_story_daily_snapshots n on n.story_id=p.id and n.snapshot_day=c.day
 left join public.trending_story_daily_snapshots w on w.story_id=p.id and w.snapshot_day=c.day-7
), access as (
 select p.id,p.episode_id,coalesce(p_preview,false) and (e.is_free_published is true or e.id in (
 select f.id from public.episodes f where f.story_id=p.id and f.deleted_at is null and f.status='published' and (f.first_published_at is null or f.first_published_at<=now())
 order by f.first_published_at asc nulls first,coalesce(f.episode_number,0) asc,f.created_at asc nulls first,f.id limit 5
 )) as free_preview
 from picked p join public.episodes e on e.id=p.episode_id
)
select jsonb_build_object(
 'story',jsonb_build_object('id',s.id,'title',s.title,'story_language',s.story_language,'story_type',s.story_type,'story_status',s.story_status,'status',s.status,'deleted_at',s.deleted_at,'admin_visibility_status',s.admin_visibility_status,'ranking_visibility_status',s.ranking_visibility_status,'is_adult',s.is_adult,'is_shadow_exclusive',s.is_shadow_exclusive,'exclusive_status',s.exclusive_status,'author_id',s.author_id,'cover_url',s.cover_url,'main_genre',s.main_genre,'tags',s.tags,'total_views',s.total_views),
 'episode',jsonb_build_object('id',e.id,'story_id',e.story_id,'title',e.title,'episode_number',e.episode_number,'status',e.status,'deleted_at',e.deleted_at,'is_adult',e.is_adult,'first_published_at',coalesce(e.first_published_at,e.published_at),'published_at',e.published_at,'scheduled_at',e.scheduled_at,'is_free_published',a.free_preview,'is_locked',not a.free_preview,'content',case when a.free_preview and lower(coalesce(s.story_type,'novel'))<>'manga' and octet_length(e.content::text)<=1000000 then to_jsonb(e.content) else null end),
 'activity7',coalesce(v.reads,0),'authorLastActiveAt',p.last_activity_at,'lastEpisodePublishedAt',x.last_episode_published_at,'publishedEpisodeCount',x.published_episode_count,'authorName',p.author_name)
from picked p join summaries x on x.story_id=p.id join public.stories s on s.id=p.id join public.episodes e on e.id=p.episode_id
join access a on a.id=p.id and a.episode_id=e.id left join activity v on v.id=p.id
where x.published_episode_count>=5 and (p_topic='update' or e.id=x.first_episode_id) and (lower(s.story_status)='completed' or x.last_episode_published_at between now()-interval '30 days' and now());
$$;

revoke all on function public.social_promotion_updates_v4(uuid,timestamptz,timestamptz,integer),public.social_promotion_fresh_candidate_v4(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.social_promotion_updates_v4(uuid,timestamptz,timestamptz,integer),public.social_promotion_fresh_candidate_v4(uuid,uuid,text,boolean) to service_role;
commit;
