begin;

create or replace function public.social_promotion_enqueue_v2(
  p_rule_id uuid,p_revision timestamptz,p_slot timestamptz,p_kind text,p_items jsonb,p_caption_id text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  r public.social_promotion_rules%rowtype;
  c public.social_media_connections%rowtype;
  conn uuid;
  job uuid;
  n integer;
  valid_count integer;
  story_keys uuid[];
  episode_keys uuid[];
  day_start timestamptz;
  day_end timestamptz;
  stamp timestamptz:=clock_timestamp();
begin
  if p_rule_id is null or p_revision is null or p_slot is null or p_kind is null or p_kind not in ('solo','group','update')
    or p_items is null or jsonb_typeof(p_items)<>'array' or (p_caption_id is not null and char_length(p_caption_id) not between 1 and 160) then
    return jsonb_build_object('state','invalid');
  end if;
  n:=jsonb_array_length(p_items);
  if (p_kind='group' and n not between 3 and 5) or (p_kind<>'group' and n<>1) then return jsonb_build_object('state','invalid'); end if;
  select array_agg((x.item->>'story_id')::uuid order by x.ord),array_agg((x.item->>'episode_id')::uuid order by x.ord)
    into story_keys,episode_keys
    from jsonb_array_elements(p_items) with ordinality as x(item,ord);
  if array_position(story_keys,null) is not null or array_position(episode_keys,null) is not null
    or (select count(distinct i) from unnest(story_keys) as t(i))<>n
    or (select count(distinct i) from unnest(episode_keys) as t(i))<>n then return jsonb_build_object('state','invalid'); end if;

  select connection_id into conn from public.social_promotion_rules where id=p_rule_id and owner_type='admin' and owner_id='shadow';
  if not found then return jsonb_build_object('state','disabled'); end if;
  select * into c from public.social_media_connections where id=conn and owner_type='admin' and owner_id='shadow' for update;
  if not found or c.status<>'connected' or c.token_ciphertext is null or (c.token_expires_at is not null and c.token_expires_at<=stamp) then return jsonb_build_object('state','disabled'); end if;
  select * into r from public.social_promotion_rules where id=p_rule_id and connection_id=conn and owner_type='admin' and owner_id='shadow' for update;
  if not found or not r.enabled or r.updated_at<>p_revision then return jsonb_build_object('state','stale_rule'); end if;
  if (p_kind='update')<>(r.source_topic='update') or (p_kind='group' and (r.source_topic='solo' or (r.source_topic='night' and n<>3))) then return jsonb_build_object('state','invalid'); end if;
  if p_slot<>date_trunc('minute',p_slot) or not coalesce((p_slot at time zone 'Asia/Phnom_Penh')::time=any(r.publish_times),false)
    or p_slot>stamp or p_slot<stamp-interval '15 minutes' then return jsonb_build_object('state','invalid_slot'); end if;
  select id into job from public.social_media_jobs where rule_id=r.id and scheduled_at=p_slot and rule_revision is not null;
  if found then return jsonb_build_object('state','existing','jobId',job); end if;
  day_start:=date_trunc('day',p_slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh';
  day_end:=day_start+interval '24 hours';
  if (select count(*) from public.social_media_jobs where rule_id=r.id and scheduled_at>=day_start and scheduled_at<day_end)>=r.daily_limit then
    return jsonb_build_object('state','daily_limit');
  end if;

  select count(*) into valid_count
  from unnest(story_keys,episode_keys) as i(story_id,episode_id)
  join public.stories s on s.id=i.story_id
  join public.episodes e on e.id=i.episode_id and e.story_id=s.id
  join public.author_pages a on a.id=s.author_id
  where exists(select 1 from public.shadow_reader_visible_stories_v1 v where v.id=s.id)
    and s.status='published' and s.deleted_at is null and s.is_adult is false
    and e.status='published' and e.deleted_at is null and e.is_adult is false
    and coalesce(s.admin_visibility_status,'active') in ('','active') and coalesce(s.ranking_visibility_status,'visible')='visible'
    and (s.is_shadow_exclusive is not true or s.exclusive_status='approved')
    and a.status='active' and coalesce(a.ranking_visibility_status,'visible')='visible'
    and nullif(trim(s.cover_url),'') is not null
    and coalesce(e.first_published_at,e.published_at)<=stamp and (e.published_at is null or e.published_at<=stamp) and (e.scheduled_at is null or e.scheduled_at<=stamp)
    and (case split_part(lower(replace(trim(s.story_language),'_','-')),'-',1)
      when 'kh' then 'km' when 'khmer' then 'km' when 'english' then 'en' when 'chinese' then 'zh'
      when 'japanese' then 'ja' when 'jp' then 'ja' when 'korean' then 'ko' when 'kr' then 'ko'
      else split_part(lower(replace(trim(s.story_language),'_','-')),'-',1) end)=r.language
    and (r.selection_mode='smart' or s.id::text=any(r.story_ids) or s.author_id::text=any(r.author_ids))
    and (cardinality(r.story_types)=0 or (case when lower(coalesce(s.story_type,'novel')) in ('short','short_story','short_novel') then 'novel' else lower(coalesce(s.story_type,'novel')) end)=any(r.story_types))
    and (p_kind<>'update' or (coalesce(e.first_published_at,e.published_at) at time zone 'Asia/Phnom_Penh')::date=(p_slot at time zone 'Asia/Phnom_Penh')::date);
  if valid_count<>n then return jsonb_build_object('state','ineligible'); end if;

  if exists (
    select 1 from public.social_media_jobs j left join public.social_media_job_items i on i.job_id=j.id
    where j.connection_id=conn and j.owner_type='admin' and j.owner_id='shadow'
      and j.status in ('queued','publishing','published','needs_review')
      and ((j.status in ('queued','publishing','needs_review') and coalesce(i.episode_id::text,j.episode_id)=any(array(select unnest(episode_keys)::text)))
      or (p_kind='update' and (j.post_kind='update' or j.rule_revision is null)
        and coalesce(i.episode_id::text,j.episode_id)=any(array(select unnest(episode_keys)::text)))
      or (p_kind<>'update' and coalesce(i.story_id::text,j.story_id)=any(array(select unnest(story_keys)::text))
        and (j.status in ('queued','publishing','needs_review') or j.finished_at>stamp-interval '14 days')))
  ) then return jsonb_build_object('state','duplicate'); end if;
  if p_caption_id is not null and exists(select 1 from public.social_media_jobs j where j.connection_id=conn and j.language=r.language and j.caption_id=p_caption_id and j.status in ('queued','publishing','published','needs_review') and (j.status<>'published' or j.finished_at>stamp-interval '7 days')) then return jsonb_build_object('state','duplicate_caption'); end if;

  insert into public.social_media_jobs(owner_type,owner_id,connection_id,rule_id,story_id,episode_id,content_mode,scheduled_at,language,post_kind,source_topic,caption_id,rule_revision)
    values('admin','shadow',conn,r.id,story_keys[1]::text,episode_keys[1]::text,'short',p_slot,r.language,p_kind,r.source_topic,p_caption_id,r.updated_at) returning id into job;
  insert into public.social_media_job_items(job_id,position,story_id,episode_id)
    select job,ord::smallint,story_id,episode_id from unnest(story_keys,episode_keys) with ordinality as x(story_id,episode_id,ord);
  return jsonb_build_object('state','queued','jobId',job);
end;
$$;

create or replace function public.social_promotion_history_v2(p_connection_id uuid,p_language text,p_story_ids uuid[])
returns jsonb language sql stable security invoker set search_path='' as $$
with scope as (
  select id from public.social_media_connections where id=p_connection_id and owner_type='admin' and owner_id='shadow'
    and p_language in ('km','en','zh','ja','ko') and cardinality(p_story_ids)<=1000
), jobs as (
  select j.* from public.social_media_jobs j join scope s on s.id=j.connection_id
  where j.owner_type='admin' and j.owner_id='shadow' and j.language=p_language
    and j.status in ('queued','publishing','published','needs_review')
    and (j.status<>'published' or j.finished_at>=now()-interval '14 days')
), history as (
  select distinct on(i.story_id) p_language as language,i.story_id as "storyId",
    case j.status when 'queued' then 'ready' when 'published' then 'sent' else 'sending' end as status,
    j.finished_at as "sentAt",coalesce(j.started_at,j.created_at) as "updatedAt"
  from jobs j join public.social_media_job_items i on i.job_id=j.id
  where i.story_id=any(p_story_ids)
  order by i.story_id,(j.status<>'published') desc,coalesce(j.finished_at,j.started_at,j.created_at) desc,j.id
), captions as (
  select distinct on(j.caption_id) p_language as language,j.source_topic as topic,j.caption_id as "captionId",
    case j.status when 'queued' then 'ready' when 'published' then 'sent' else 'sending' end as status,
    case when j.status='published' then j.finished_at else now() end as "sentAt"
  from jobs j where j.caption_id is not null and (j.status<>'published' or j.finished_at>=now()-interval '7 days')
  order by j.caption_id,(j.status<>'published') desc,coalesce(j.finished_at,j.started_at,j.created_at) desc,j.id
)
select jsonb_build_object('history',coalesce((select jsonb_agg(to_jsonb(h)) from history h),'[]'::jsonb),'captionHistory',coalesce((select jsonb_agg(to_jsonb(c)) from captions c),'[]'::jsonb));
$$;

revoke all on function public.social_promotion_enqueue_v2(uuid,timestamptz,timestamptz,text,jsonb,text),public.social_promotion_history_v2(uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.social_promotion_enqueue_v2(uuid,timestamptz,timestamptz,text,jsonb,text),public.social_promotion_history_v2(uuid,text,uuid[]) to service_role;
commit;
