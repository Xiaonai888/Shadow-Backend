begin;

create or replace function public.telegram_promotion_candidates_v1(p_language text,p_kind text,p_slot text)
returns table(story_id uuid,episode_id uuid,activity_7 bigint,author_last_active_at timestamptz,last_episode_published_at timestamptz,published_episode_count bigint,author_story_count bigint,author_name text)
language sql stable security invoker set search_path='' as $$
with scope as (
 select case p_language when 'km' then 'Khmer' when 'en' then 'English' when 'zh' then 'Chinese' when 'ko' then 'Korean' when 'ja' then 'Japanese' end as lang,
 (now() at time zone 'Asia/Phnom_Penh')::date as day
), visible as materialized (
 select s.id,s.author_id,s.story_status,s.story_type,r.last_activity_at,coalesce(a.page_name,a.page_username,'') as author_name
 from public.shadow_reader_visible_stories_v1 v join public.stories s on s.id=v.id
 join public.author_pages a on a.id=s.author_id
 left join public.reader_presence r on r.user_id=a.user_id
 cross join scope x
 where s.story_language=x.lang and s.status='published' and s.deleted_at is null
 and coalesce(s.admin_visibility_status,'active') in ('','active') and s.is_adult is not true
 and coalesce(s.ranking_visibility_status,'visible')='visible'
 and (s.is_shadow_exclusive is not true or s.exclusive_status='approved')
 and a.status='active' and coalesce(a.ranking_visibility_status,'visible')='visible'
 and nullif(trim(s.cover_url),'') is not null
), author_counts as (
 select author_id,count(*) as n from visible group by author_id
), coverage as (
 select x.day, exists(select 1 from public.trending_story_daily_snapshots where snapshot_day=x.day)
 and exists(select 1 from public.trending_story_daily_snapshots where snapshot_day=x.day-7) as ready
 from scope x where p_kind='trending'
), weekly as (
 select v.id,case when c.ready then greatest(0,coalesce(n.total_views-w.total_views,
 case when s.created_at>=((c.day-6)::timestamp at time zone 'Asia/Phnom_Penh') then n.total_views end,0))::bigint
 else coalesce(f.reads,0)::bigint end as activity
 from visible v join public.stories s on s.id=v.id cross join coverage c
 left join public.trending_story_daily_snapshots n on n.story_id=v.id and n.snapshot_day=c.day
 left join public.trending_story_daily_snapshots w on w.story_id=v.id and w.snapshot_day=c.day-7
 left join lateral (select sum(d.episode_reads) as reads from public.admin_story_reader_daily d where not c.ready and d.story_id=v.id and d.activity_day>=c.day-7 and d.activity_day<c.day) f on true
), shortlist as materialized (
 select v.*,coalesce(w.activity,0) as activity,coalesce(ac.n,0) as author_count
 from visible v left join weekly w on w.id=v.id left join author_counts ac on ac.author_id=v.author_id
 where p_kind in ('completed','short','trending','author')
 and (p_kind not in ('completed','short') or lower(coalesce(v.story_status,''))='completed')
 and (p_kind<>'short' or lower(coalesce(v.story_type,'novel')) in ('novel','short','short_story','short_novel'))
 and (p_kind<>'trending' or w.activity>0)
 and (p_kind<>'author' or ac.n>=3)
 and ((lower(coalesce(v.story_status,''))='completed' and p_kind<>'author') or v.last_activity_at between now()-interval '30 days' and now())
 and not exists(select 1 from public.telegram_promotion_queue q where q.language=p_language and q.story_id=v.id and q.kind<>'update' and q.status in ('ready','sending','sent','uncertain') and (q.status in ('ready','sending') or coalesce(q.sent_at,q.updated_at)>=now()-interval '14 days'))
 and (p_kind<>'author' or not exists(select 1 from public.telegram_promotion_queue q where q.language=p_language and q.author_id=v.author_id and q.kind='author' and q.status in ('ready','sending','sent','uncertain') and (q.status in ('ready','sending') or coalesce(q.sent_at,q.updated_at)>=now()-interval '30 days')))
 order by case when p_kind='trending' then w.activity end desc nulls last,md5(v.id::text||coalesce(p_slot,'')),v.id limit 100
), summaries as (
 select * from public.smart_ad_episode_summaries_v1(array(select id from shortlist))
)
select v.id,e.first_episode_id,v.activity,v.last_activity_at,e.last_episode_published_at,e.published_episode_count,v.author_count,v.author_name
from shortlist v join summaries e on e.story_id=v.id
join public.episodes ep on ep.id=e.first_episode_id
where ep.is_adult is not true and e.first_episode_id is not null
and (lower(coalesce(v.story_status,''))='completed' or e.last_episode_published_at between now()-interval '30 days' and now())
and (p_kind<>'short' or lower(coalesce(v.story_type,'novel')) in ('short','short_story','short_novel') or e.published_episode_count between 1 and 9)
order by case when p_kind='trending' then v.activity end desc nulls last,md5(v.id::text||coalesce(p_slot,'')),v.id limit 30;
$$;

create or replace function public.telegram_promotion_job_context_v1(p_story_id uuid,p_episode_id uuid,p_kind text)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object(
 'story',jsonb_build_object('id',s.id,'story_language',s.story_language,'story_type',s.story_type,'story_status',s.story_status,'status',s.status,'deleted_at',s.deleted_at,'admin_visibility_status',s.admin_visibility_status,'is_adult',s.is_adult,'is_shadow_exclusive',s.is_shadow_exclusive,'exclusive_status',s.exclusive_status,'cover_url',s.cover_url,'author_id',s.author_id),
 'episode',jsonb_build_object('id',e.id,'story_id',e.story_id,'status',e.status,'deleted_at',e.deleted_at,'is_adult',e.is_adult,'first_published_at',case when p_kind='update' then e.first_published_at else coalesce(e.first_published_at,e.published_at) end,'published_at',e.published_at,'scheduled_at',e.scheduled_at),
 'authorLastActiveAt',r.last_activity_at,'lastEpisodePublishedAt',x.last_episode_published_at,'publishedEpisodeCount',x.published_episode_count,
 'authorStoryCount',case when p_kind='author' then (select count(*) from public.shadow_reader_visible_stories_v1 v where v.author_id=s.author_id and v.story_language=s.story_language and v.status='published' and v.deleted_at is null and v.is_adult is not true) else 0 end
)
from public.stories s join public.episodes e on e.story_id=s.id and e.id=p_episode_id
join public.shadow_reader_visible_stories_v1 v on v.id=s.id
join public.author_pages a on a.id=s.author_id and a.status='active'
left join public.reader_presence r on r.user_id=a.user_id
left join lateral (select * from public.smart_ad_episode_summaries_v1(case when p_kind<>'update' then array[s.id] else array[]::uuid[] end)) x on true
where s.id=p_story_id and coalesce(s.ranking_visibility_status,'visible')='visible' and coalesce(a.ranking_visibility_status,'visible')='visible';
$$;

revoke all on function public.telegram_promotion_candidates_v1(text,text,text),public.telegram_promotion_job_context_v1(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.telegram_promotion_candidates_v1(text,text,text),public.telegram_promotion_job_context_v1(uuid,uuid,text) to service_role;
commit;
