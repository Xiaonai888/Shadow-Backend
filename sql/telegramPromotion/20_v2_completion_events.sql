begin;

create index if not exists telegram_promotion_v2_completion_time_idx on public.telegram_promotion_v2_story_completion(completed_at,story_id);

create or replace function public.telegram_promotion_v2_completion_due(p_language text)
returns jsonb language sql stable security invoker set search_path='' as $$
with candidates as (
  select s.id as story_id,c.completed_at,x.id as episode_id
  from public.telegram_promotion_v2_story_completion c
  join public.stories s on s.id=c.story_id
  join public.shadow_reader_visible_stories_v1 v on v.id=s.id
  join public.author_pages a on a.id=s.author_id and a.status='active'
  join public.telegram_promotion_settings t on t.language=p_language and t.enabled and t.channel_id is not null
  cross join lateral (
    select e.id from public.episodes e where e.story_id=s.id and e.status='published' and e.deleted_at is null and coalesce(e.first_published_at,e.published_at)<=now() and (e.published_at is null or e.published_at<=now()) and (e.scheduled_at is null or e.scheduled_at<=now()) order by e.episode_number asc nulls last,e.created_at,e.id limit 1
  ) x
  join public.episodes ep on ep.id=x.id and ep.is_adult is not true
  where p_language in ('km','en') and c.completed_at>=greatest(t.enabled_at,now()-interval '1 day') and c.completed_at<=now()
  and public.telegram_promotion_language_v1(s.story_language)=p_language and lower(s.story_status)='completed' and s.status='published' and s.deleted_at is null and s.is_adult is not true
  and coalesce(s.admin_visibility_status,'active') in ('','active') and coalesce(s.ranking_visibility_status,'visible')='visible' and coalesce(a.ranking_visibility_status,'visible')='visible'
  and (s.is_shadow_exclusive is not true or s.exclusive_status='approved') and nullif(trim(s.cover_url),'') is not null
  and (select count(*) from (select 1 from public.episodes e where e.story_id=s.id and e.status='published' and e.deleted_at is null and coalesce(e.first_published_at,e.published_at)<=now() and (e.published_at is null or e.published_at<=now()) and (e.scheduled_at is null or e.scheduled_at<=now()) limit 5) n)=5
  and not exists(select 1 from public.episodes e where e.story_id=s.id and e.status='published' and e.deleted_at is null and e.first_published_at>=(date_trunc('day',c.completed_at at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh') and e.first_published_at<=now())
  and not exists(select 1 from public.telegram_promotion_queue q where q.language=p_language and q.job_key='completion:'||s.id::text||':'||extract(epoch from c.completed_at)::text)
  order by c.completed_at,s.id limit 3
)
select coalesce(jsonb_agg(to_jsonb(candidates)),'[]'::jsonb) from candidates;
$$;

create or replace function public.telegram_promotion_v2_enqueue_completion(p_language text,p_story_id uuid,p_episode_id uuid,p_completed_at timestamptz,p_payload jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_id uuid; v_key text; v_settings public.telegram_promotion_settings%rowtype;
begin
  if p_language is null or p_language not in ('km','en') or p_story_id is null or p_episode_id is null or p_completed_at is null or jsonb_typeof(p_payload) is distinct from 'object' or p_payload ? 'media' or jsonb_typeof(p_payload->'caption') is distinct from 'string' or length(p_payload->>'caption')>1000 or jsonb_typeof(p_payload->'photo') is distinct from 'string' or jsonb_typeof(p_payload->'reply_markup') is distinct from 'object' or left(p_payload->>'caption',length('✅ Just Completed'))<>'✅ Just Completed' then raise exception 'Invalid completion payload'; end if;
  select * into v_settings from public.telegram_promotion_settings where language=p_language for update;
  if not found or not v_settings.enabled or v_settings.channel_id is null then return null; end if;
  v_key:='completion:'||p_story_id::text||':'||extract(epoch from p_completed_at)::text;
  select id into v_id from public.telegram_promotion_queue where language=p_language and job_key=v_key;
  if found then return v_id; end if;
  if not exists(select 1 from jsonb_array_elements(public.telegram_promotion_v2_completion_due(p_language)) j where (j->>'story_id')::uuid=p_story_id and (j->>'episode_id')::uuid=p_episode_id and (j->>'completed_at')::timestamptz=p_completed_at) then return null; end if;
  insert into public.telegram_promotion_queue(language,job_key,kind,story_id,episode_id,author_id,payload,due_at,expires_at)
  select p_language,v_key,'solo',s.id,p_episode_id,s.author_id,p_payload,now(),p_completed_at+interval '1 day' from public.stories s where s.id=p_story_id returning id into v_id;
  insert into public.telegram_promotion_v2_message_meta(queue_id,post_type,topic) values(v_id,'solo','completed');
  return v_id;
end;
$$;

create or replace function public.telegram_promotion_v2_completion_valid(p_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
select exists(select 1 from public.telegram_promotion_queue q join public.telegram_promotion_v2_story_completion c on c.story_id=q.story_id join public.stories s on s.id=q.story_id
where q.id=p_id and q.kind='solo' and q.job_key='completion:'||s.id::text||':'||extract(epoch from c.completed_at)::text and lower(s.story_status)='completed' and q.expires_at>now()
and not exists(select 1 from public.episodes e where e.story_id=s.id and e.status='published' and e.deleted_at is null and e.first_published_at>=(date_trunc('day',c.completed_at at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh') and e.first_published_at<=now()));
$$;

revoke all on function public.telegram_promotion_v2_completion_due(text),public.telegram_promotion_v2_enqueue_completion(text,uuid,uuid,timestamptz,jsonb),public.telegram_promotion_v2_completion_valid(uuid) from public,anon,authenticated;
grant execute on function public.telegram_promotion_v2_completion_due(text),public.telegram_promotion_v2_enqueue_completion(text,uuid,uuid,timestamptz,jsonb),public.telegram_promotion_v2_completion_valid(uuid) to service_role;
commit;
