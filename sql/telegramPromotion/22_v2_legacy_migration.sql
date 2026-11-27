begin;

create or replace function public.telegram_promotion_v2_utf16_length(p_text text)
returns integer language sql immutable strict security invoker set search_path='' as $$
select coalesce(sum(case when ascii(substr(p_text,i,1))>65535 then 2 else 1 end),0)::integer from generate_series(1,length(p_text)) i;
$$;

create or replace function public.telegram_promotion_v2_legacy_payload(p_payload jsonb)
returns jsonb language plpgsql immutable strict security invoker set search_path='' as $$
declare
  v_caption text:=p_payload->>'caption';
  v_entities jsonb:=case when jsonb_typeof(p_payload->'caption_entities')='array' then p_payload->'caption_entities' else '[]'::jsonb end;
  v_result jsonb:='[]'::jsonb;
  v_total integer;
  v_tail_offset integer;
  v_tail_index integer;
  v_tail text:='';
  v_prefix text:='';
  v_prefix_units integer:=0;
  v_units integer:=0;
  v_budget integer:=960;
  v_char integer;
  v_entity jsonb;
  v_offset integer;
  v_length integer;
  v_new_offset integer;
begin
  if v_caption is null then raise exception 'Missing legacy caption'; end if;
  v_total:=public.telegram_promotion_v2_utf16_length(v_caption);
  if v_total<=960 then return p_payload||jsonb_build_object('v2_base_caption',v_caption,'v2_revision',1,'v2_legacy_imported',true); end if;
  select min((e->>'offset')::integer) into v_tail_offset from jsonb_array_elements(v_entities) e where e->>'type'='text_link' and (e->>'offset') ~ '^\d+$';
  if v_tail_offset is not null and v_tail_offset>=0 and v_tail_offset<v_total and v_total-v_tail_offset<=700 then
    for i in 1..length(v_caption) loop
      if v_units=v_tail_offset then v_tail_index:=i;exit;end if;
      v_units:=v_units+case when ascii(substr(v_caption,i,1))>65535 then 2 else 1 end;
    end loop;
    if v_tail_index is not null then
      v_tail:=substr(v_caption,v_tail_index);
      v_budget:=least(v_tail_offset,960-(v_total-v_tail_offset)-2);
    end if;
  end if;
  for i in 1..length(v_caption) loop
    v_char:=case when ascii(substr(v_caption,i,1))>65535 then 2 else 1 end;
    if v_prefix_units+v_char>v_budget then exit;end if;
    v_prefix:=v_prefix||substr(v_caption,i,1);
    v_prefix_units:=v_prefix_units+v_char;
  end loop;
  for v_entity in select value from jsonb_array_elements(v_entities) loop
    if coalesce(v_entity->>'offset','') !~ '^\d+$' or coalesce(v_entity->>'length','') !~ '^\d+$' then continue;end if;
    v_offset:=(v_entity->>'offset')::integer;v_length:=(v_entity->>'length')::integer;
    if v_length<=0 or v_offset+v_length>v_total then continue;end if;
    if v_offset+v_length<=v_prefix_units then
      v_result:=v_result||jsonb_build_array(v_entity);
    elsif v_tail_index is not null and v_offset>=v_tail_offset then
      v_new_offset:=v_prefix_units+2+v_offset-v_tail_offset;
      v_result:=v_result||jsonb_build_array(jsonb_set(v_entity,'{offset}',to_jsonb(v_new_offset)));
    end if;
  end loop;
  v_caption:=v_prefix||case when v_tail_index is null then '' else E'\n\n'||v_tail end;
  return p_payload||jsonb_build_object('caption',v_caption,'caption_entities',v_result,'v2_base_caption',v_caption,'v2_revision',1,'v2_legacy_imported',true);
end;
$$;

create or replace function public.telegram_promotion_v2_import_legacy_day(p_language text,p_story_id uuid,p_day date)
returns integer language plpgsql security invoker set search_path='' as $$
declare
  v_settings public.telegram_promotion_settings%rowtype;
  v_ids uuid[];
  v_episodes uuid[];
  v_dates timestamptz[];
  v_count integer;
  v_index integer;
  v_group integer;
  v_anchor public.telegram_promotion_queue%rowtype;
  v_payload jsonb;
  v_start timestamptz:=p_day::timestamp at time zone 'Asia/Phnom_Penh';
  v_end timestamptz:=(p_day+1)::timestamp at time zone 'Asia/Phnom_Penh';
begin
  if p_language not in ('km','en') or p_story_id is null or p_day is null then raise exception 'Invalid legacy migration scope';end if;
  select * into v_settings from public.telegram_promotion_settings where language=p_language for update;
  if not found or not v_settings.enabled or v_settings.channel_id is null then return 0;end if;
  if exists(select 1 from public.telegram_promotion_v2_update_groups where language=p_language and story_id=p_story_id and local_day=p_day) then return 0;end if;
  if exists(select 1 from public.telegram_promotion_queue q join public.episodes e on e.id=q.episode_id where q.language=p_language and q.story_id=p_story_id and q.kind='update' and q.status in ('ready','sending') and e.first_published_at>=v_start and e.first_published_at<v_end and not exists(select 1 from public.telegram_promotion_v2_message_meta m where m.queue_id=q.id)) then raise exception 'LEGACY_QUEUE_NOT_DRAINED';end if;
  if exists(select 1 from public.telegram_promotion_queue q join public.episodes e on e.id=q.episode_id where q.language=p_language and q.story_id=p_story_id and q.kind='update' and q.status='sent' and e.first_published_at>=v_start and e.first_published_at<v_end and not exists(select 1 from public.telegram_promotion_v2_message_meta m where m.queue_id=q.id) and (q.telegram_chat_id is distinct from v_settings.channel_id or coalesce(q.telegram_message_id,0)<=0)) then raise exception 'LEGACY_MESSAGE_CHANNEL_OR_ID_MISMATCH';end if;
  select array_agg(q.id order by e.first_published_at,e.id),array_agg(e.id order by e.first_published_at,e.id),array_agg(e.first_published_at order by e.first_published_at,e.id)
  into v_ids,v_episodes,v_dates
  from public.telegram_promotion_queue q join public.episodes e on e.id=q.episode_id and e.story_id=q.story_id
  where q.language=p_language and q.story_id=p_story_id and q.kind='update' and q.status='sent' and e.first_published_at>=v_start and e.first_published_at<v_end and not exists(select 1 from public.telegram_promotion_v2_message_meta m where m.queue_id=q.id);
  v_count:=coalesce(cardinality(v_ids),0);
  if v_count=0 then return 0;end if;
  for v_group in 1..least(v_count,3) loop
    v_index:=case when v_group=3 then v_count else v_group end;
    select * into strict v_anchor from public.telegram_promotion_queue where id=v_ids[v_index] for update;
    v_payload:=public.telegram_promotion_v2_legacy_payload(v_anchor.payload);
    update public.telegram_promotion_queue set payload=v_payload where id=v_anchor.id;
    insert into public.telegram_promotion_v2_message_meta(queue_id,post_type,telegram_message_ids) values(v_anchor.id,'update',array[v_anchor.telegram_message_id]);
    insert into public.telegram_promotion_v2_update_groups(language,story_id,local_day,group_no,queue_id,first_episode_id,first_published_at,desired_revision,applied_revision,next_edit_at)
    values(p_language,p_story_id,p_day,v_group,v_anchor.id,v_episodes[v_index],v_dates[v_index],1,1,null);
  end loop;
  for v_index in 1..v_count loop
    insert into public.telegram_promotion_v2_update_episodes(language,episode_id,story_id,local_day,group_no,first_published_at)
    values(p_language,v_episodes[v_index],p_story_id,p_day,least(v_index,3),v_dates[v_index]);
    update public.telegram_promotion_events set state='queued',last_error=null,updated_at=now() where language=p_language and episode_id=v_episodes[v_index] and state='pending';
  end loop;
  return v_count;
end;
$$;

revoke all on function public.telegram_promotion_v2_utf16_length(text),public.telegram_promotion_v2_legacy_payload(jsonb),public.telegram_promotion_v2_import_legacy_day(text,uuid,date) from public,anon,authenticated;
grant execute on function public.telegram_promotion_v2_utf16_length(text),public.telegram_promotion_v2_legacy_payload(jsonb),public.telegram_promotion_v2_import_legacy_day(text,uuid,date) to service_role;

create or replace function public.telegram_promotion_v2_enqueue_update(p_language text,p_episode_id uuid,p_payload jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_settings public.telegram_promotion_settings%rowtype;
  v_event public.telegram_promotion_events%rowtype;
  v_group public.telegram_promotion_v2_update_groups%rowtype;
  v_day date;
  v_no smallint;
  v_queue uuid;
  v_row record;
  v_caption text;
  v_payload jsonb;
  v_count integer;
begin
  if p_language is null or p_language not in ('km','en') or p_episode_id is null then raise exception 'Invalid update event'; end if;
  select * into v_settings from public.telegram_promotion_settings where language=p_language for update;
  if not found or not v_settings.enabled or v_settings.channel_id is null then return jsonb_build_object('state','disabled'); end if;
  select * into v_event from public.telegram_promotion_events where language=p_language and episode_id=p_episode_id for update;
  if not found then return jsonb_build_object('state','missing_event'); end if;
  select g.queue_id into v_queue from public.telegram_promotion_v2_update_episodes e join public.telegram_promotion_v2_update_groups g using(language,story_id,local_day,group_no) where e.language=p_language and e.episode_id=p_episode_id;
  if found then return jsonb_build_object('state','existing','queueId',v_queue); end if;
  select id into v_queue from public.telegram_promotion_queue where language=p_language and kind='update' and episode_id=p_episode_id;
  if found then
    update public.telegram_promotion_events set state='queued',updated_at=now(),last_error=null where language=p_language and episode_id=p_episode_id and state='pending';
    return jsonb_build_object('state','legacy_existing','queueId',v_queue);
  end if;
  if v_event.state<>'pending' or v_event.due_at>now() or v_event.first_published_at>now() then return jsonb_build_object('state','not_due'); end if;
  if not exists(select 1 from public.stories s join public.episodes e on e.story_id=s.id join public.shadow_reader_visible_stories_v1 v on v.id=s.id join public.author_pages a on a.id=s.author_id and a.status='active' where s.id=v_event.story_id and e.id=p_episode_id and public.telegram_promotion_language_v1(s.story_language)=p_language and s.status='published' and s.deleted_at is null and e.status='published' and e.deleted_at is null and e.first_published_at=v_event.first_published_at and (e.published_at is null or e.published_at<=now()) and (e.scheduled_at is null or e.scheduled_at<=now()) and coalesce(s.admin_visibility_status,'active') in ('','active') and coalesce(s.ranking_visibility_status,'visible')='visible' and coalesce(a.ranking_visibility_status,'visible')='visible' and (s.is_shadow_exclusive is not true or s.exclusive_status='approved')) then return jsonb_build_object('state','ineligible'); end if;
  v_day:=(v_event.first_published_at at time zone 'Asia/Phnom_Penh')::date;
  perform public.telegram_promotion_v2_import_legacy_day(p_language,v_event.story_id,v_day);
  select * into v_group from public.telegram_promotion_v2_update_groups where language=p_language and story_id=v_event.story_id and local_day=v_day order by group_no desc limit 1;
  if not found or (v_group.group_no<3 and v_event.first_published_at>=v_group.first_published_at+interval '1 hour') then
    v_no:=coalesce(v_group.group_no,0)+1;
    if p_payload is null then return jsonb_build_object('state','needs_payload'); end if;
    if jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_payload->'caption') is distinct from 'string' or length(p_payload->>'caption')>960 or jsonb_typeof(p_payload->'photo') is distinct from 'string' or jsonb_typeof(p_payload->'reply_markup') is distinct from 'object' then raise exception 'Invalid update payload'; end if;
    if p_payload ? 'media' then
      if jsonb_typeof(p_payload->'media') is distinct from 'array' then raise exception 'Invalid update album'; end if;
      if jsonb_array_length(p_payload->'media') not between 3 and 5 or (p_payload->'media'->0->>'caption') is distinct from (p_payload->>'caption') then raise exception 'Invalid update album'; end if;
    end if;
    v_payload:=p_payload||jsonb_build_object('v2_base_caption',p_payload->>'caption','v2_revision',1);
    insert into public.telegram_promotion_queue(language,job_key,kind,story_id,episode_id,author_id,payload,due_at)
    select p_language,'update:'||p_episode_id::text,'update',s.id,p_episode_id,s.author_id,v_payload,now() from public.stories s where s.id=v_event.story_id returning id into v_queue;
    insert into public.telegram_promotion_v2_message_meta(queue_id,post_type) values(v_queue,'update');
    insert into public.telegram_promotion_v2_update_groups(language,story_id,local_day,group_no,queue_id,first_episode_id,first_published_at) values(p_language,v_event.story_id,v_day,v_no,v_queue,p_episode_id,v_event.first_published_at);
  else
    select * into v_group from public.telegram_promotion_v2_update_groups where language=p_language and story_id=v_event.story_id and local_day=v_day order by case when first_published_at<=v_event.first_published_at then 0 else 1 end,case when first_published_at<=v_event.first_published_at then group_no end desc,group_no asc limit 1;
    if exists(select 1 from public.telegram_promotion_queue q where q.id=v_group.queue_id and q.payload->>'v2_legacy_imported'='true') and not exists(
      select 1 from public.stories s join public.episodes e on e.story_id=s.id join public.shadow_reader_visible_stories_v1 v on v.id=s.id join public.author_pages a on a.id=s.author_id and a.status='active'
      where s.id=v_event.story_id and e.id=v_group.first_episode_id and s.status='published' and s.deleted_at is null and s.is_adult is not true and e.status='published' and e.deleted_at is null and e.is_adult is not true and coalesce(s.admin_visibility_status,'active') in ('','active') and coalesce(s.ranking_visibility_status,'visible')='visible' and coalesce(a.ranking_visibility_status,'visible')='visible' and (s.is_shadow_exclusive is not true or s.exclusive_status='approved')
    ) then raise exception 'LEGACY_ANCHOR_NO_LONGER_PUBLIC: review before editing'; end if;
    v_no:=v_group.group_no;
    v_queue:=v_group.queue_id;
  end if;
  insert into public.telegram_promotion_v2_update_episodes(language,episode_id,story_id,local_day,group_no,first_published_at) values(p_language,p_episode_id,v_event.story_id,v_day,v_no,v_event.first_published_at);
  for v_row in select g.queue_id,g.group_no,g.desired_revision,q.payload,q.status from public.telegram_promotion_v2_update_groups g join public.telegram_promotion_queue q on q.id=g.queue_id where g.language=p_language and g.story_id=v_event.story_id and g.local_day=v_day and g.group_no>=v_no order by g.group_no loop
    select count(*)::integer into v_count from public.telegram_promotion_v2_update_episodes e where e.language=p_language and e.story_id=v_event.story_id and e.local_day=v_day and e.group_no<=v_row.group_no;
    v_caption:=v_row.payload->>'v2_base_caption';
    if v_caption is null then raise exception 'Missing base update caption'; end if;
    if v_count>1 then v_caption:=v_caption||E'\n\nUP +'||(v_count-1)::text; end if;
    v_payload:=v_row.payload||jsonb_build_object('caption',v_caption,'v2_revision',v_row.desired_revision+1);
    if jsonb_typeof(v_payload->'media')='array' then v_payload:=jsonb_set(v_payload,'{media,0,caption}',to_jsonb(v_caption)); end if;
    update public.telegram_promotion_queue set payload=v_payload,updated_at=now() where id=v_row.queue_id;
    update public.telegram_promotion_v2_update_groups set desired_revision=desired_revision+1,next_edit_at=case when v_row.status='sent' then now() else next_edit_at end,edit_attempts=case when edit_lease_until is null or edit_lease_until<=now() then 0 else edit_attempts end,last_edit_error=null,updated_at=now() where queue_id=v_row.queue_id;
  end loop;
  update public.telegram_promotion_events set state='queued',attempts=attempts+1,last_error=null,updated_at=now() where language=p_language and episode_id=p_episode_id;
  return jsonb_build_object('state','queued','queueId',v_queue,'groupNo',v_no);
end;
$$;

revoke all on function public.telegram_promotion_v2_enqueue_update(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.telegram_promotion_v2_enqueue_update(text,uuid,jsonb) to service_role;

do $$
declare
  v_day date:=(now() at time zone 'Asia/Phnom_Penh')::date;
  v_start timestamptz:=v_day::timestamp at time zone 'Asia/Phnom_Penh';
  v_end timestamptz:=(v_day+1)::timestamp at time zone 'Asia/Phnom_Penh';
  v_scope record;
  v_missing integer;
begin
  perform 1 from public.telegram_promotion_settings where language in ('km','en') order by language for update;
  if exists(select 1 from public.telegram_promotion_queue q join public.telegram_promotion_settings s on s.language=q.language and s.enabled where q.language in ('km','en') and q.status in ('ready','sending') and not exists(select 1 from public.telegram_promotion_v2_message_meta m where m.queue_id=q.id)) then raise exception 'LEGACY_QUEUE_NOT_DRAINED: enable V1 to finish active jobs, then pause it again';end if;
  if exists(select 1 from public.telegram_promotion_queue q join public.telegram_promotion_settings s on s.language=q.language and s.enabled where q.language in ('km','en') and q.status='uncertain' and q.updated_at>=v_start) then raise exception 'UNCERTAIN_TELEGRAM_DELIVERY: verify old messages before cutover';end if;
  for v_scope in select distinct q.language,q.story_id from public.telegram_promotion_queue q join public.telegram_promotion_settings s on s.language=q.language and s.enabled join public.episodes e on e.id=q.episode_id where q.language in ('km','en') and q.kind='update' and q.status='sent' and e.first_published_at>=v_start and e.first_published_at<v_end and not exists(select 1 from public.telegram_promotion_v2_update_episodes u where u.language=q.language and u.episode_id=q.episode_id) loop
    perform public.telegram_promotion_v2_import_legacy_day(v_scope.language,v_scope.story_id,v_day);
  end loop;
  select count(*)::integer into v_missing from public.telegram_promotion_queue q join public.telegram_promotion_settings s on s.language=q.language and s.enabled join public.episodes e on e.id=q.episode_id where q.language in ('km','en') and q.kind='update' and q.status='sent' and e.first_published_at>=v_start and e.first_published_at<v_end and not exists(select 1 from public.telegram_promotion_v2_update_episodes u where u.language=q.language and u.episode_id=q.episode_id);
  if v_missing<>0 then raise exception 'LEGACY_MIGRATION_INCOMPLETE: % episodes',v_missing;end if;
  if public.telegram_promotion_v2_utf16_length('A😀')<>3 then raise exception 'UTF16 validation failed';end if;
end;
$$;

commit;

with bounds as (
  select (now() at time zone 'Asia/Phnom_Penh')::date as day
), stats as (
  select s.language,s.enabled,
    (select count(*) from public.telegram_promotion_v2_update_episodes u where u.language=s.language and u.local_day=b.day) as mapped_episodes,
    (select count(*) from public.telegram_promotion_v2_update_groups g join public.telegram_promotion_queue q on q.id=g.queue_id where g.language=s.language and g.local_day=b.day and q.payload->>'v2_legacy_imported'='true') as legacy_anchors,
    (select count(*) from public.telegram_promotion_queue q join public.episodes e on e.id=q.episode_id where q.language=s.language and q.kind='update' and q.status='sent' and e.first_published_at>=b.day::timestamp at time zone 'Asia/Phnom_Penh' and e.first_published_at<(b.day+1)::timestamp at time zone 'Asia/Phnom_Penh' and not exists(select 1 from public.telegram_promotion_v2_update_episodes u where u.language=q.language and u.episode_id=q.episode_id)) as unmapped_sent,
    (select count(*) from public.telegram_promotion_queue q where q.language=s.language and q.status in ('ready','sending') and not exists(select 1 from public.telegram_promotion_v2_message_meta m where m.queue_id=q.id)) as legacy_active,
    (select count(*) from public.telegram_promotion_events e where e.language=s.language and e.state='pending' and e.due_at<=now()) as pending_events
  from public.telegram_promotion_settings s cross join bounds b where s.language in ('km','en')
)
select *,case when not enabled then 'DISABLED' when unmapped_sent=0 and legacy_active=0 then 'READY_FOR_V2' else 'REVIEW_REQUIRED' end as cutover_status from stats order by language;
