begin;

create or replace function public.shadow_smart_content_candidate_page_v1(
 p_language text,p_topic text,p_seed text,p_offset integer default 0,
 p_history_scope text default 'neutral',p_story_ids uuid[] default '{}',
 p_author_ids uuid[] default '{}',p_story_types text[] default '{}'
) returns jsonb language sql stable security invoker set search_path='' as $$
with scope as (
 select (now() at time zone 'Asia/Phnom_Penh')::date as day
 where p_language in ('km','en','zh','ja','ko') and p_topic in ('gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','similar','night','solo')
 and p_offset between 0 and 900 and length(p_seed) between 1 and 100
 and p_history_scope in ('neutral','telegram')
 and cardinality(p_story_ids)<=1000 and cardinality(p_author_ids)<=1000 and cardinality(p_story_types)<=3
 and p_story_types <@ array['novel','manga','chat_story']::text[]
 and (p_history_scope='neutral' or (p_language in ('km','en') and cardinality(p_story_ids)=0 and cardinality(p_author_ids)=0 and cardinality(p_story_types)=0))
), visible as materialized (
 select s.id,s.author_id,s.story_status,s.story_type,s.total_views,s.created_at,r.last_activity_at,coalesce(a.page_name,a.page_username,'') as author_name
 from public.shadow_reader_visible_stories_v1 v join public.stories s on s.id=v.id
 join public.author_pages a on a.id=s.author_id
 left join public.reader_presence r on r.user_id=a.user_id
 cross join scope x
 where (case when p_history_scope='telegram' then public.telegram_promotion_language_v1(s.story_language)
 else case split_part(lower(replace(trim(s.story_language),'_','-')),'-',1)
 when 'kh' then 'km' when 'khmer' then 'km' when 'english' then 'en' when 'chinese' then 'zh'
 when 'japanese' then 'ja' when 'jp' then 'ja' when 'korean' then 'ko' when 'kr' then 'ko'
 else split_part(lower(replace(trim(s.story_language),'_','-')),'-',1) end end)=p_language
 and s.status='published' and s.deleted_at is null and s.is_adult is not true
 and coalesce(s.admin_visibility_status,'active') in ('','active') and coalesce(s.ranking_visibility_status,'visible')='visible'
 and (s.is_shadow_exclusive is not true or s.exclusive_status='approved')
 and a.status='active' and coalesce(a.ranking_visibility_status,'visible')='visible'
 and nullif(trim(s.cover_url),'') is not null
 and (cardinality(p_story_ids)=0 and cardinality(p_author_ids)=0 or s.id=any(p_story_ids) or s.author_id=any(p_author_ids))
 and (cardinality(p_story_types)=0 or (case when lower(coalesce(s.story_type,'novel')) in ('short','short_story','short_novel') then 'novel' else lower(coalesce(s.story_type,'novel')) end)=any(p_story_types))
 and (lower(s.story_status)='completed' or r.last_activity_at between now()-interval '30 days' and now())
 and (p_topic not in ('completed','short') or lower(s.story_status)='completed')
 and (p_topic<>'short' or lower(coalesce(s.story_type,'novel')) in ('novel','short','short_story','short_novel'))
 and (p_topic not in ('gl','bl','romance','fantasy','comedy') or exists (
   select 1 from jsonb_array_elements_text(jsonb_build_array(s.main_genre)||coalesce(to_jsonb(s.tags),'[]'::jsonb)) t(value)
   where case lower(regexp_replace(trim(t.value),'[[:space:]_-]+',' ','g'))
     when 'girls love' then 'gl' when 'girls'' love' then 'gl' when 'boys love' then 'bl' when 'boys'' love' then 'bl'
     when 'ស្នេហា' then 'romance' when 'កំប្លែង' then 'comedy' when 'ស្រមើស្រមៃ' then 'fantasy'
     else lower(regexp_replace(trim(t.value),'[[:space:]_-]+',' ','g')) end=p_topic
 ))
), coverage as (
 select x.day,exists(select 1 from public.trending_story_daily_snapshots where snapshot_day=x.day)
 and exists(select 1 from public.trending_story_daily_snapshots where snapshot_day=x.day-7) as ready
 from scope x where p_topic in ('trending','night')
), weekly as (
 select v.id,case when c.ready then greatest(0,coalesce(n.total_views-w.total_views,
 case when v.created_at>=((c.day-6)::timestamp at time zone 'Asia/Phnom_Penh') then n.total_views end,0))::bigint
 else coalesce(f.reads,0)::bigint end as activity
 from visible v cross join coverage c
 left join public.trending_story_daily_snapshots n on n.story_id=v.id and n.snapshot_day=c.day
 left join public.trending_story_daily_snapshots w on w.story_id=v.id and w.snapshot_day=c.day-7
 left join lateral (select sum(d.episode_reads) as reads from public.admin_story_reader_daily d where not c.ready and d.story_id=v.id and d.activity_day>=c.day-7 and d.activity_day<c.day) f on true
), exposure as materialized (
 select h.story_id,max(coalesce(h.sent_at,h.updated_at)) as last_at,bool_or(h.status in ('ready','sending')) as pending
 from public.telegram_promotion_v2_exposure_history h join visible v on v.id=h.story_id
 where p_history_scope='telegram' and h.language=p_language group by h.story_id
), batch as materialized (
 select v.*,coalesce(w.activity,0) as activity,e.last_at
 from visible v left join weekly w on w.id=v.id left join exposure e on e.story_id=v.id
 where not coalesce(e.pending,false) and (p_topic<>'trending' or w.activity>0)
 order by case when e.last_at>=now()-interval '14 days' then 1 else 0 end,
 case when p_topic='trending' then w.activity end desc nulls last,
 case when p_topic='hidden' then v.total_views end asc nulls last,
 e.last_at asc nulls first,md5(v.id::text||p_seed),v.id
 limit 100 offset greatest(0,least(900,coalesce(p_offset,0)))
), summaries as (
 select * from public.smart_ad_episode_summaries_v1(array(select id from batch))
), eligible as (
 select b.*,x.first_episode_id,x.published_episode_count,x.last_episode_published_at
 from batch b join summaries x on x.story_id=b.id
 join public.episodes e on e.id=x.first_episode_id and e.story_id=b.id
 where x.published_episode_count>=5 and e.is_adult is not true
 and (e.scheduled_at is null or e.scheduled_at<=now())
 and (lower(b.story_status)='completed' or x.last_episode_published_at between now()-interval '30 days' and now())
 and (p_topic<>'short' or lower(coalesce(b.story_type,'novel')) in ('short','short_story','short_novel') or x.published_episode_count between 5 and 9)
 and (p_topic<>'new' or coalesce(e.first_published_at,e.published_at)>=now()-interval '14 days')
), rows as (
 select b.id,jsonb_build_object(
 'story',jsonb_build_object('id',s.id,'title',s.title,'story_language',s.story_language,'story_type',s.story_type,'story_status',s.story_status,'status',s.status,'deleted_at',s.deleted_at,'admin_visibility_status',s.admin_visibility_status,'ranking_visibility_status',s.ranking_visibility_status,'is_adult',s.is_adult,'is_shadow_exclusive',s.is_shadow_exclusive,'exclusive_status',s.exclusive_status,'author_id',s.author_id,'cover_url',s.cover_url,'main_genre',s.main_genre,'tags',s.tags,'total_views',s.total_views),
 'episode',jsonb_build_object('id',e.id,'story_id',e.story_id,'title',e.title,'episode_number',e.episode_number,'status',e.status,'deleted_at',e.deleted_at,'is_adult',e.is_adult,'first_published_at',coalesce(e.first_published_at,e.published_at),'published_at',e.published_at,'scheduled_at',e.scheduled_at),
 'activity7',b.activity,'authorLastActiveAt',b.last_activity_at,'lastEpisodePublishedAt',b.last_episode_published_at,'publishedEpisodeCount',b.published_episode_count,'authorName',b.author_name) as item
 from eligible b join public.stories s on s.id=b.id join public.episodes e on e.id=b.first_episode_id
), history as (
 select distinct on (h.story_id) h.story_id,h.language,h.status,h.sent_at,h.updated_at
 from public.telegram_promotion_v2_exposure_history h join rows r on r.id=h.story_id
 where p_history_scope='telegram' and h.language=p_language
 order by h.story_id,(h.status in ('ready','sending')) desc,coalesce(h.sent_at,h.updated_at) desc,h.queue_id
), captions as (
 select distinct on (h.caption_id) h.caption_id,h.language,h.topic,h.status,h.sent_at,h.updated_at
 from public.telegram_promotion_v2_caption_history h
 where p_history_scope='telegram' and h.language=p_language and (h.status in ('ready','sending') or coalesce(h.sent_at,h.updated_at)>=now()-interval '7 days')
 order by h.caption_id,(h.status in ('ready','sending')) desc,coalesce(h.sent_at,h.updated_at) desc,h.queue_id
)
select jsonb_build_object('scanned',(select count(*) from batch),
 'candidates',coalesce((select jsonb_agg(item order by id) from rows),'[]'::jsonb),
 'history',coalesce((select jsonb_agg(to_jsonb(h)) from history h),'[]'::jsonb),
 'captions',coalesce((select jsonb_agg(to_jsonb(c)) from captions c),'[]'::jsonb));
$$;

revoke all on function public.shadow_smart_content_candidate_page_v1(text,text,text,integer,text,uuid[],uuid[],text[]) from public,anon,authenticated;
grant execute on function public.shadow_smart_content_candidate_page_v1(text,text,text,integer,text,uuid[],uuid[],text[]) to service_role;
commit;
