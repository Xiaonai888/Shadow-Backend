begin;

alter table public.telegram_promotion_queue drop constraint if exists telegram_promotion_queue_kind_check;
alter table public.telegram_promotion_queue add constraint telegram_promotion_queue_kind_check check (kind in ('update','completed','short','trending','author','solo','group'));

create or replace function public.telegram_promotion_v2_enqueue_optional(p_language text,p_slot text,p_post_type text,p_topic text,p_caption_id text,p_items jsonb,p_payload jsonb,p_due_at timestamptz,p_expires_at timestamptz,p_cooldown_days integer default 14)
returns uuid language plpgsql security invoker set search_path='' as $$
declare
  v_settings public.telegram_promotion_settings%rowtype;
  v_id uuid;
  v_count integer;
  v_first jsonb;
  v_item jsonb;
  v_day date := (now() at time zone 'Asia/Phnom_Penh')::date;
  v_position integer := 0;
begin
  if p_language is null or p_language not in ('km','en') or p_slot is null or p_slot !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' or p_post_type is null or p_post_type not in ('solo','group') or p_topic is null or p_topic not in ('gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','similar','night','author') then raise exception 'Invalid optional promotion'; end if;
  if p_due_at is null or p_expires_at is null or p_expires_at<=now() or p_expires_at<=p_due_at then return null; end if;
  if p_cooldown_days is null or (p_topic='night' and p_cooldown_days not in (1,3,7,14)) or (p_topic<>'night' and p_cooldown_days<>14) then raise exception 'Invalid cooldown'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Invalid optional payload'; end if;
  v_count:=jsonb_array_length(p_items);
  if (p_post_type='solo' and v_count<>1) or (p_post_type='group' and v_count not between 3 and 5) or (p_topic='night' and (p_post_type<>'group' or v_count<>3)) then raise exception 'Invalid group size'; end if;
  if p_post_type='group' then
    if nullif(p_caption_id,'') is null or jsonb_typeof(p_payload->'media') is distinct from 'array' then raise exception 'Invalid group payload'; end if;
    if jsonb_array_length(p_payload->'media')<>v_count then raise exception 'Invalid group media count'; end if;
  end if;
  if (select count(distinct (j->>'storyId')::uuid) from jsonb_array_elements(p_items) j)<>v_count then raise exception 'Duplicate or missing story'; end if;
  select * into v_settings from public.telegram_promotion_settings where language=p_language for update;
  if not found or not v_settings.enabled or v_settings.channel_id is null then return null; end if;
  select id into v_id from public.telegram_promotion_queue where language=p_language and job_key='slot:'||p_slot;
  if found then return v_id; end if;
  if exists(select 1 from jsonb_array_elements(p_items) j join public.telegram_promotion_v2_exposure_history h on h.story_id=(j->>'storyId')::uuid and h.language=p_language where h.status in ('ready','sending') or coalesce(h.sent_at,h.updated_at)>now()-make_interval(days=>p_cooldown_days) or (coalesce(h.sent_at,h.updated_at) at time zone 'Asia/Phnom_Penh')::date>=v_day-1) then return null; end if;
  if p_caption_id is not null and exists(select 1 from public.telegram_promotion_v2_caption_history h where h.language=p_language and h.caption_id=p_caption_id and (h.status in ('ready','sending') or coalesce(h.sent_at,h.updated_at)>=now()-interval '7 days')) then return null; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if not exists(select 1 from public.stories s join public.episodes e on e.story_id=s.id join public.shadow_reader_visible_stories_v1 v on v.id=s.id join public.author_pages a on a.id=s.author_id and a.status='active' left join public.reader_presence r on r.user_id=a.user_id cross join lateral public.smart_ad_episode_summaries_v1(array[s.id]) x where s.id=(v_item->>'storyId')::uuid and e.id=(v_item->>'episodeId')::uuid and x.first_episode_id=e.id and public.telegram_promotion_language_v1(s.story_language)=p_language and s.status='published' and s.deleted_at is null and s.is_adult is not true and e.status='published' and e.deleted_at is null and e.is_adult is not true and (e.scheduled_at is null or e.scheduled_at<=now()) and coalesce(s.admin_visibility_status,'active') in ('','active') and coalesce(s.ranking_visibility_status,'visible')='visible' and coalesce(a.ranking_visibility_status,'visible')='visible' and (s.is_shadow_exclusive is not true or s.exclusive_status='approved') and nullif(trim(s.cover_url),'') is not null and x.published_episode_count>=5 and (lower(s.story_status)='completed' or (r.last_activity_at between now()-interval '30 days' and now() and x.last_episode_published_at between now()-interval '30 days' and now())) and (p_topic not in ('completed','short') or lower(s.story_status)='completed') and (p_topic<>'short' or lower(coalesce(s.story_type,'novel')) in ('short','short_story','short_novel') or (lower(coalesce(s.story_type,'novel'))='novel' and x.published_episode_count between 5 and 9))) then return null; end if;
  end loop;
  v_first:=p_items->0;
  insert into public.telegram_promotion_queue(language,job_key,kind,story_id,episode_id,author_id,payload,due_at,expires_at)
  select p_language,'slot:'||p_slot,p_post_type,s.id,(v_first->>'episodeId')::uuid,s.author_id,p_payload,p_due_at,p_expires_at from public.stories s where s.id=(v_first->>'storyId')::uuid returning id into v_id;
  insert into public.telegram_promotion_v2_message_meta(queue_id,post_type,topic,caption_id) values(v_id,p_post_type,p_topic,p_caption_id);
  if p_post_type='group' then
    for v_item in select value from jsonb_array_elements(p_items) loop
      v_position:=v_position+1;
      insert into public.telegram_promotion_v2_group_stories(queue_id,story_id,episode_id,position) values(v_id,(v_item->>'storyId')::uuid,(v_item->>'episodeId')::uuid,v_position);
    end loop;
  end if;
  return v_id;
end;
$$;

create or replace function public.telegram_promotion_v2_finish(p_id uuid,p_attempt integer,p_outcome text,p_error text default null,p_message_ids bigint[] default null,p_media_group_id text default null,p_retry_seconds integer default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare
  v_job public.telegram_promotion_queue%rowtype;
  v_expected integer;
  v_ok boolean;
begin
  select * into v_job from public.telegram_promotion_queue where id=p_id;
  if not found then return false; end if;
  if p_outcome='sent' then
    v_expected:=case when jsonb_typeof(v_job.payload->'media')='array' then jsonb_array_length(v_job.payload->'media') else 1 end;
    if p_message_ids is null or cardinality(p_message_ids)<>v_expected or array_position(p_message_ids,null::bigint) is not null or not (0<all(p_message_ids)) or (select count(distinct x) from unnest(p_message_ids) x)<>v_expected then raise exception 'Invalid Telegram delivery IDs'; end if;
    if v_expected>1 and nullif(p_media_group_id,'') is null then raise exception 'Missing Telegram album ID'; end if;
    if v_expected=1 and p_media_group_id is not null then raise exception 'Unexpected Telegram album ID'; end if;
    if not exists(select 1 from public.telegram_promotion_v2_message_meta where queue_id=p_id) then raise exception 'Missing V2 metadata'; end if;
  end if;
  v_ok:=public.telegram_promotion_finish_v1(p_id,p_attempt,p_outcome,p_error,p_message_ids[1],p_retry_seconds);
  if not v_ok then return false; end if;
  if p_outcome='sent' then
    update public.telegram_promotion_v2_message_meta set telegram_message_ids=p_message_ids,telegram_media_group_id=p_media_group_id,updated_at=now() where queue_id=p_id;
  end if;
  return true;
end;
$$;

revoke all on function public.telegram_promotion_v2_enqueue_optional(text,text,text,text,text,jsonb,jsonb,timestamptz,timestamptz,integer),public.telegram_promotion_v2_finish(uuid,integer,text,text,bigint[],text,integer) from public,anon,authenticated;
grant execute on function public.telegram_promotion_v2_enqueue_optional(text,text,text,text,text,jsonb,jsonb,timestamptz,timestamptz,integer),public.telegram_promotion_v2_finish(uuid,integer,text,text,bigint[],text,integer) to service_role;
commit;
