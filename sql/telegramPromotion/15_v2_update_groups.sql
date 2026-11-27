begin;

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
  if exists(select 1 from public.telegram_promotion_queue q join public.episodes e on e.id=q.episode_id left join public.telegram_promotion_v2_message_meta m on m.queue_id=q.id where q.language=p_language and q.story_id=v_event.story_id and q.kind='update' and m.queue_id is null and (e.first_published_at at time zone 'Asia/Phnom_Penh')::date=v_day) then return jsonb_build_object('state','legacy_day'); end if;
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
commit;
