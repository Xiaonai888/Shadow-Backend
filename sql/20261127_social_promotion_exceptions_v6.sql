begin;

create table if not exists public.social_promotion_exceptions (
  kind text not null check (kind in ('story','author')),
  target_id uuid not null,
  display_name text not null,
  story_language text check (story_language in ('km','en','zh','ja','ko')),
  created_at timestamptz not null default now(),
  primary key(kind,target_id),
  check (kind='story' or story_language is null)
);
create index if not exists social_promotion_exceptions_list_v6_idx on public.social_promotion_exceptions(kind,created_at desc,target_id);
alter table public.social_promotion_exceptions enable row level security;
revoke all on public.social_promotion_exceptions from public,anon,authenticated;
grant select,insert,delete on public.social_promotion_exceptions to service_role;

create or replace function public.social_promotion_language_v6(value text)
returns text language sql immutable security invoker set search_path='' as $$
select case split_part(lower(replace(trim(value),'_','-')),'-',1)
when 'km' then 'km' when 'kh' then 'km' when 'khmer' then 'km' when 'en' then 'en' when 'english' then 'en'
when 'zh' then 'zh' when 'chinese' then 'zh' when 'ja' then 'ja' when 'jp' then 'ja' when 'japanese' then 'ja'
when 'ko' then 'ko' when 'kr' then 'ko' when 'korean' then 'ko' end;
$$;

create or replace function public.social_promotion_story_blocked_v6(p_story_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
select exists(select 1 from public.social_promotion_exceptions x where x.kind='story' and x.target_id=p_story_id)
 or exists(select 1 from public.stories s join public.social_promotion_exceptions x on x.kind='author' and x.target_id=s.author_id where s.id=p_story_id);
$$;

create or replace function public.social_promotion_allowed_stories_v6(p_story_ids uuid[])
returns jsonb language sql stable security invoker set search_path='' as $$
select coalesce(jsonb_agg(s.id order by s.id),'[]'::jsonb)
from public.stories s where cardinality(p_story_ids) between 1 and 1000 and s.id=any(p_story_ids)
and not public.social_promotion_story_blocked_v6(s.id);
$$;

create or replace function public.social_promotion_exception_list_v6(p_kind text,p_language text,p_search text,p_page integer,p_blocked_only boolean)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_kind is null or p_kind not in ('story','author') or p_language is null or p_language not in ('all','km','en','zh','ja','ko')
    or p_page is null or p_page not between 1 and 10000 or p_search is null or char_length(p_search)>120 or p_blocked_only is null then
    raise exception using errcode='22023',message='SOCIAL_EXCEPTION_LIST_INVALID';
  end if;
  if p_kind='author' and p_language<>'all' then raise exception using errcode='22023',message='SOCIAL_EXCEPTION_LANGUAGE_INVALID'; end if;
  if p_blocked_only then
    with rows as (
      select x.target_id as id,x.kind,coalesce(nullif(s.title,''),nullif(a.page_name,''),nullif(a.page_username,''),x.display_name) as name,
      case when x.kind='story' then coalesce(public.social_promotion_language_v6(s.story_language),x.story_language) end as language,
      case when x.kind='story' then s.cover_url else a.avatar_url end as image_url,
      coalesce(nullif(sa.page_name,''),nullif(sa.page_username,''),'') as author_name,true as blocked,x.created_at as sort_at
      from public.social_promotion_exceptions x
      left join public.stories s on x.kind='story' and s.id=x.target_id
      left join public.author_pages a on x.kind='author' and a.id=x.target_id
      left join public.author_pages sa on sa.id=s.author_id
      where x.kind=p_kind
    ), page as (
      select * from rows where (p_language='all' or language=p_language)
      and (p_search='' or strpos(lower(name),lower(p_search))>0 or strpos(lower(author_name),lower(p_search))>0 or id::text=lower(p_search))
      order by sort_at desc,id limit 11 offset ((p_page-1)*10)
    ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(t)-'sort_at' order by sort_at desc,id) from (select * from page order by sort_at desc,id limit 10)t),'[]'::jsonb),'hasMore',(select count(*)>10 from page),'page',p_page) into result;
  elsif p_kind='story' then
    with page as (
      select s.id,'story'::text as kind,s.title as name,public.social_promotion_language_v6(s.story_language) as language,s.cover_url as image_url,
      coalesce(nullif(a.page_name,''),nullif(a.page_username,''),'') as author_name,public.social_promotion_story_blocked_v6(s.id) as blocked,s.updated_at as sort_at
      from public.stories s left join public.author_pages a on a.id=s.author_id
      where s.deleted_at is null and s.status='published' and nullif(trim(s.title),'') is not null
      and (p_language='all' or public.social_promotion_language_v6(s.story_language)=p_language)
      and (p_search='' or strpos(lower(s.title),lower(p_search))>0 or strpos(lower(coalesce(a.page_name,'')),lower(p_search))>0 or strpos(lower(coalesce(a.page_username,'')),lower(p_search))>0 or s.id::text=lower(p_search))
      order by s.updated_at desc nulls last,s.id limit 11 offset ((p_page-1)*10)
    ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(t)-'sort_at' order by sort_at desc nulls last,id) from (select * from page order by sort_at desc nulls last,id limit 10)t),'[]'::jsonb),'hasMore',(select count(*)>10 from page),'page',p_page) into result;
  else
    with page as (
      select a.id,'author'::text as kind,coalesce(nullif(a.page_name,''),nullif(a.page_username,''),a.id::text) as name,null::text as language,a.avatar_url as image_url,
      ''::text as author_name,exists(select 1 from public.social_promotion_exceptions x where x.kind='author' and x.target_id=a.id) as blocked
      from public.author_pages a
      where (p_search='' or strpos(lower(coalesce(a.page_name,'')),lower(p_search))>0 or strpos(lower(coalesce(a.page_username,'')),lower(p_search))>0 or a.id::text=lower(p_search))
      order by coalesce(nullif(a.page_name,''),nullif(a.page_username,''),a.id::text),a.id limit 11 offset ((p_page-1)*10)
    ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(t) order by name,id) from (select * from page order by name,id limit 10)t),'[]'::jsonb),'hasMore',(select count(*)>10 from page),'page',p_page) into result;
  end if;
  return result;
end;
$$;

create or replace function public.social_promotion_exception_change_v6(p_kind text,p_target_id uuid,p_block boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare label text; lang text; cancelled integer:=0; changed integer:=0;
begin
  if p_kind is null or p_kind not in ('story','author') or p_target_id is null or p_block is null then raise exception using errcode='22023',message='SOCIAL_EXCEPTION_INPUT_INVALID'; end if;
  perform pg_advisory_xact_lock(721104,33008);
  if not p_block then
    delete from public.social_promotion_exceptions where kind=p_kind and target_id=p_target_id;
    get diagnostics changed=row_count;
    return jsonb_build_object('state','removed','changed',changed>0,'cancelled',0);
  end if;
  if p_kind='story' then
    select coalesce(nullif(title,''),id::text),public.social_promotion_language_v6(story_language) into label,lang from public.stories where id=p_target_id;
  else
    select coalesce(nullif(page_name,''),nullif(page_username,''),id::text) into label from public.author_pages where id=p_target_id;
  end if;
  if not found then return jsonb_build_object('state','not_found','changed',false,'cancelled',0); end if;
  insert into public.social_promotion_exceptions(kind,target_id,display_name,story_language) values(p_kind,p_target_id,label,lang) on conflict do nothing;
  get diagnostics changed=row_count;
  update public.social_media_jobs j set status='cancelled',finished_at=clock_timestamp(),error_code='SOCIAL_EXCEPTION_BLOCKED'
  where j.owner_type='admin' and j.owner_id='shadow' and j.status='queued'
  and (exists(select 1 from public.social_media_job_items i where i.job_id=j.id and public.social_promotion_story_blocked_v6(i.story_id))
       or exists(select 1 from public.stories s where s.id::text=j.story_id and public.social_promotion_story_blocked_v6(s.id)));
  get diagnostics cancelled=row_count;
  return jsonb_build_object('state','blocked','changed',changed>0,'cancelled',cancelled);
end;
$$;

create or replace function public.social_promotion_exception_item_guard_v6()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if exists(select 1 from public.social_media_jobs j where j.id=new.job_id and j.owner_type='admin' and j.owner_id='shadow') then
    perform pg_advisory_xact_lock(721104,33008);
    if public.social_promotion_story_blocked_v6(new.story_id) then raise exception using errcode='23514',message='SOCIAL_EXCEPTION_BLOCKED'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists social_promotion_exception_item_guard_v6 on public.social_media_job_items;
create trigger social_promotion_exception_item_guard_v6 before insert or update of story_id,job_id on public.social_media_job_items for each row execute function public.social_promotion_exception_item_guard_v6();

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

revoke all on function public.social_promotion_language_v6(text),public.social_promotion_story_blocked_v6(uuid),public.social_promotion_allowed_stories_v6(uuid[]),public.social_promotion_exception_list_v6(text,text,text,integer,boolean),public.social_promotion_exception_change_v6(text,uuid,boolean),public.social_promotion_exception_item_guard_v6(),public.social_promotion_worker_context_v3(uuid,uuid) from public,anon,authenticated;
grant execute on function public.social_promotion_language_v6(text),public.social_promotion_story_blocked_v6(uuid),public.social_promotion_allowed_stories_v6(uuid[]),public.social_promotion_exception_list_v6(text,text,text,integer,boolean),public.social_promotion_exception_change_v6(text,uuid,boolean),public.social_promotion_exception_item_guard_v6(),public.social_promotion_worker_context_v3(uuid,uuid) to service_role;
commit;
