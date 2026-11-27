begin;

alter table public.social_media_jobs add column if not exists worker_claim_id uuid;

create or replace function public.social_promotion_claim_v3()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  j public.social_media_jobs%rowtype;
  stamp timestamptz := clock_timestamp();
  claim uuid := gen_random_uuid();
begin
  if not pg_try_advisory_xact_lock(721104, 33007) then return null; end if;
  with stale as (
    select id from public.social_media_jobs where owner_type='admin' and owner_id='shadow'
    and rule_revision is not null and status='publishing'
    and coalesce(started_at,created_at)<stamp-interval '15 minutes'
    order by started_at nulls first,id limit 20 for update skip locked
  ) update public.social_media_jobs x set status='needs_review',finished_at=stamp,error_code='SOCIAL_WORKER_STALE_CLAIM',worker_claim_id=null
    from stale where x.id=stale.id;
  if exists(select 1 from public.social_media_jobs where owner_type='admin' and owner_id='shadow' and status='publishing' and rule_revision is not null) then return null; end if;
  with expired as (
    select id from public.social_media_jobs where owner_type='admin' and owner_id='shadow' and rule_revision is not null
    and status='queued' and scheduled_at<stamp-interval '30 minutes' order by scheduled_at,id limit 50 for update skip locked
  ) update public.social_media_jobs x set status='cancelled',finished_at=stamp,error_code='SOCIAL_WORKER_SLOT_EXPIRED'
    from expired where x.id=expired.id;
  select * into j from public.social_media_jobs where owner_type='admin' and owner_id='shadow' and rule_revision is not null
    and status='queued' and scheduled_at between stamp-interval '30 minutes' and stamp
    order by scheduled_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.social_media_jobs set status='publishing',started_at=stamp,worker_claim_id=claim where id=j.id returning * into j;
  return jsonb_build_object('job',to_jsonb(j),'items',coalesce((select jsonb_agg(to_jsonb(i) order by i.position) from public.social_media_job_items i where i.job_id=j.id),'[]'::jsonb));
end;
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
  and (c.token_expires_at is null or c.token_expires_at>now())
  and (select count(*) from public.social_media_job_items i where i.job_id=j.id) between (case when j.post_kind='group' then 3 else 1 end) and (case when j.post_kind='group' then 5 else 1 end)
  and not exists (
    select 1 from public.social_media_job_items i
    left join public.stories s on s.id=i.story_id
    left join public.episodes e on e.id=i.episode_id and e.story_id=i.story_id
    left join public.author_pages a on a.id=s.author_id
    where i.job_id=j.id and not coalesce((s.id is not null and e.id is not null and a.id is not null
      and exists(select 1 from public.shadow_reader_visible_stories_v1 v where v.id=s.id)
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

create or replace function public.social_promotion_finish_v3(p_job_id uuid,p_claim_id uuid,p_status text,p_post_id text default null,p_error_code text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_status is null or p_status not in ('published','failed','needs_review','cancelled')
    or (p_status='published' and (p_post_id is null or p_post_id !~ '^[0-9]{1,40}(_[0-9]{1,40})?$' or p_error_code is not null))
    or (p_status<>'published' and (p_post_id is not null or p_error_code is null or p_error_code !~ '^[A-Z0-9_]{1,100}$')) then return false; end if;
  update public.social_media_jobs set status=p_status,external_post_id=p_post_id,error_code=p_error_code,finished_at=clock_timestamp(),worker_claim_id=null
  where id=p_job_id and worker_claim_id=p_claim_id and status='publishing' and owner_type='admin' and owner_id='shadow' and rule_revision is not null;
  return found;
end;
$$;

revoke all on function public.social_promotion_claim_v3(),public.social_promotion_worker_context_v3(uuid,uuid),public.social_promotion_finish_v3(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.social_promotion_claim_v3(),public.social_promotion_worker_context_v3(uuid,uuid),public.social_promotion_finish_v3(uuid,uuid,text,text,text) to service_role;
commit;
