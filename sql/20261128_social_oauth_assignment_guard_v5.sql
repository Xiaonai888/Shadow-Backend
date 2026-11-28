begin;

create or replace function public.social_promotion_rule_assignment_guard_v5()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.owner_type='admin' and new.owner_id='shadow' and new.enabled then
    perform 1 from public.social_media_connections where id=new.connection_id and owner_type='admin' and owner_id='shadow' for key share nowait;
    if not found or not exists(select 1 from public.social_media_bot_assignments b where b.connection_id=new.connection_id and b.owner_type='admin' and b.owner_id='shadow' and b.bot_key='promotion') then
      raise exception using errcode='23514',message='SOCIAL_BOT_ASSIGNMENT_REQUIRED';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists social_promotion_rule_assignment_guard_v5 on public.social_promotion_rules;
create trigger social_promotion_rule_assignment_guard_v5 before insert or update of enabled,connection_id,owner_type,owner_id on public.social_promotion_rules for each row execute function public.social_promotion_rule_assignment_guard_v5();


create or replace function public.social_promotion_account_cap_v5()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  start_at timestamptz;
begin
  if new.owner_type<>'admin' or new.owner_id<>'shadow' or new.rule_revision is null then return new; end if;
  perform 1 from public.social_media_connections where id=new.connection_id for update;
  if not exists(select 1 from public.social_media_bot_assignments b where b.connection_id=new.connection_id and b.owner_type='admin' and b.owner_id='shadow' and b.bot_key='promotion') then raise exception using errcode='23514',message='SOCIAL_BOT_ASSIGNMENT_REQUIRED'; end if;
  start_at:=date_trunc('day',new.scheduled_at at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh';
  if (select count(*) from public.social_media_jobs j where j.connection_id=new.connection_id and j.owner_type='admin' and j.owner_id='shadow' and j.scheduled_at>=start_at and j.scheduled_at<start_at+interval '24 hours')>=3 then
    raise exception using errcode='23514',message='SOCIAL_ACCOUNT_DAILY_LIMIT';
  end if;
  return new;
end;
$$;

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
  if not exists(select 1 from public.social_media_bot_assignments b where b.connection_id=conn and b.owner_type='admin' and b.owner_id='shadow' and b.bot_key='promotion') then return jsonb_build_object('state','disabled'); end if;
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

create or replace function public.social_promotion_poll_v5(p_skip jsonb default '[]'::jsonb)
returns jsonb language sql stable security invoker set search_path='' as $$
with clock as (
  select now() as stamp, (now() at time zone 'Asia/Phnom_Penh')::date as local_day
), skip as (
  select x->>'ruleId' as rule_id, x->>'slot' as slot
  from jsonb_array_elements(case when jsonb_typeof(p_skip)='array' then p_skip else '[]'::jsonb end) x
  limit 200
), due as (
  select r.id,r.connection_id,((d.day+t.slot_time) at time zone 'Asia/Phnom_Penh') as slot,to_jsonb(r) as rule,r.daily_limit
  from public.social_promotion_rules r join public.social_media_connections c on c.id=r.connection_id
  cross join clock x
  cross join lateral (values (x.local_day),(x.local_day-1)) d(day)
  cross join lateral unnest(r.publish_times) t(slot_time)
  where r.owner_type='admin' and r.owner_id='shadow' and r.enabled and r.content_mode='short'
  and c.owner_type='admin' and c.owner_id='shadow' and c.platform in ('facebook','instagram','threads') and c.status='connected'
  and exists(select 1 from public.social_media_bot_assignments b where b.connection_id=c.id and b.owner_type='admin' and b.owner_id='shadow' and b.bot_key='promotion')
  and c.token_ciphertext is not null and (c.token_expires_at is null or c.token_expires_at>x.stamp)
  and ((d.day+t.slot_time) at time zone 'Asia/Phnom_Penh') between x.stamp-interval '15 minutes' and x.stamp
), available as (
  select d.* from due d
  where not exists(select 1 from skip s where s.rule_id=d.id::text and s.slot=to_char(d.slot at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  and not exists(select 1 from public.social_media_jobs j where j.rule_id=d.id and j.scheduled_at=d.slot and j.rule_revision is not null)
  and (select count(*) from public.social_media_jobs j where j.connection_id=d.connection_id and j.owner_type='admin' and j.owner_id='shadow' and j.scheduled_at>=date_trunc('day',d.slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh' and j.scheduled_at<(date_trunc('day',d.slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh')+interval '24 hours')<3
  and (select count(*) from public.social_media_jobs j where j.rule_id=d.id and j.scheduled_at>=date_trunc('day',d.slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh' and j.scheduled_at<(date_trunc('day',d.slot at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh')+interval '24 hours')<d.daily_limit
  order by d.slot,d.id limit 12
)
select jsonb_build_object('due',coalesce((select jsonb_agg(jsonb_build_object('rule',rule,'slot',slot) order by slot,id) from available),'[]'::jsonb),
 'hasWork',exists(select 1 from public.social_media_jobs where owner_type='admin' and owner_id='shadow' and rule_revision is not null and ((status='queued' and scheduled_at<=now()) or (status='publishing' and coalesce(started_at,created_at)<now()-interval '15 minutes'))));
$$;

create or replace function public.social_promotion_worker_context_v3(p_job_id uuid,p_claim_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('rule',to_jsonb(r),'connection',jsonb_build_object('id',c.id,'owner_type',c.owner_type,'owner_id',c.owner_id,'platform',c.platform,'external_id',c.external_id,'token_ciphertext',c.token_ciphertext,'token_expires_at',c.token_expires_at))
from public.social_media_jobs j join public.social_promotion_rules r on r.id=j.rule_id and r.connection_id=j.connection_id
join public.social_media_connections c on c.id=j.connection_id
where j.id=p_job_id and j.worker_claim_id=p_claim_id and j.status='publishing' and j.owner_type='admin' and j.owner_id='shadow'
  and j.started_at>=now()-interval '15 minutes' and j.content_mode='short'
  and r.owner_type='admin' and r.owner_id='shadow' and r.enabled and r.updated_at=j.rule_revision and r.language=j.language and r.source_topic=j.source_topic
  and c.owner_type='admin' and c.owner_id='shadow' and c.status='connected' and c.token_ciphertext is not null
  and c.platform in ('facebook','instagram','threads')
  and exists(select 1 from public.social_media_bot_assignments b where b.connection_id=c.id and b.owner_type='admin' and b.owner_id='shadow' and b.bot_key='promotion')
  and (c.token_expires_at is null or c.token_expires_at>now())
  and (select count(*) from public.social_media_job_items i where i.job_id=j.id) between (case when j.post_kind='group' then 3 else 1 end) and (case when j.post_kind='group' then 5 else 1 end)
  and not exists (
    select 1 from public.social_media_job_items i
    left join public.stories s on s.id=i.story_id
    left join public.episodes e on e.id=i.episode_id and e.story_id=i.story_id
    left join public.author_pages a on a.id=s.author_id
    where i.job_id=j.id and not coalesce((s.id is not null and e.id is not null and a.id is not null
      and exists(select 1 from public.shadow_reader_visible_stories_v1 v where v.id=s.id)
      and not public.social_promotion_story_blocked_v6(s.id)
      and s.status='published' and s.deleted_at is null and s.is_adult is false
      and e.status='published' and e.deleted_at is null and e.is_adult is false
      and coalesce(s.admin_visibility_status,'active') in ('','active') and coalesce(s.ranking_visibility_status,'visible')='visible'
      and (s.is_shadow_exclusive is not true or s.exclusive_status='approved') and a.status='active' and coalesce(a.ranking_visibility_status,'visible')='visible'
      and coalesce(e.first_published_at,e.published_at)<=now() and (e.published_at is null or e.published_at<=now()) and (e.scheduled_at is null or e.scheduled_at<=now())
      and (case split_part(lower(replace(trim(s.story_language),'_','-')),'-',1) when 'kh' then 'km' when 'khmer' then 'km' when 'english' then 'en' when 'chinese' then 'zh' when 'jp' then 'ja' when 'japanese' then 'ja' when 'kr' then 'ko' when 'korean' then 'ko' else split_part(lower(replace(trim(s.story_language),'_','-')),'-',1) end)=r.language
      and (r.selection_mode='smart' or s.id::text=any(r.story_ids) or s.author_id::text=any(r.author_ids))
      and (cardinality(r.story_types)=0 or (case when lower(coalesce(s.story_type,'novel')) in ('short','short_story','short_novel') then 'novel' else lower(coalesce(s.story_type,'novel')) end)=any(r.story_types))
    ),false)
  );
$$;

create or replace function public.social_promotion_assignment_ready_v5()
returns boolean language sql stable security invoker set search_path='' as $$
select true;
$$;

revoke all on function public.social_promotion_assignment_ready_v5(),public.social_promotion_account_cap_v5(),public.social_promotion_enqueue_v2(uuid,timestamptz,timestamptz,text,jsonb,text),public.social_promotion_poll_v5(jsonb),public.social_promotion_worker_context_v3(uuid,uuid),public.social_promotion_rule_assignment_guard_v5() from public,anon,authenticated;
grant execute on function public.social_promotion_assignment_ready_v5(),public.social_promotion_enqueue_v2(uuid,timestamptz,timestamptz,text,jsonb,text),public.social_promotion_poll_v5(jsonb),public.social_promotion_worker_context_v3(uuid,uuid) to service_role;
commit;
