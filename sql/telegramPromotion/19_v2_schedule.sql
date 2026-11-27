begin;

create index if not exists telegram_promotion_v2_daily_created_idx on public.telegram_promotion_queue(language,created_at) where status in ('ready','sending','sent','uncertain');
create index if not exists telegram_promotion_v2_daily_sent_idx on public.telegram_promotion_queue(language,sent_at) where status='sent';

create or replace function public.telegram_promotion_v2_slot_context(p_language text,p_slot text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  v_day date := (now() at time zone 'Asia/Phnom_Penh')::date;
  v_start timestamptz := v_day::timestamp at time zone 'Asia/Phnom_Penh';
  v_end timestamptz := (v_day+1)::timestamp at time zone 'Asia/Phnom_Penh';
  v_existing uuid;
  v_updates integer;
  v_daytime integer;
  v_topics jsonb;
  v_similar jsonb;
begin
  if p_language is null or p_language not in ('km','en') or p_slot is null or p_slot !~ '^\d{4}-\d{2}-\d{2}T(11|18|21):00$' or left(p_slot,10)<>v_day::text then raise exception 'Invalid V2 slot'; end if;
  select id into v_existing from public.telegram_promotion_queue where language=p_language and job_key='slot:'||p_slot;
  select count(*)::integer into v_updates from public.telegram_promotion_queue q where q.language=p_language and q.kind='update' and q.status in ('ready','sending','sent','uncertain') and ((q.created_at>=v_start and q.created_at<v_end) or (q.status='sent' and q.sent_at>=v_start and q.sent_at<v_end));
  select count(*)::integer into v_daytime from public.telegram_promotion_queue q where q.language=p_language and q.kind<>'update' and q.status in ('ready','sending','sent','uncertain') and q.job_key in ('slot:'||v_day::text||'T11:00','slot:'||v_day::text||'T18:00');
  select coalesce(jsonb_agg(jsonb_build_object('topic',t.topic,'at',t.last_at)),'[]'::jsonb) into v_topics from (
    select coalesce(m.topic,q.kind) as topic,max(coalesce(q.sent_at,q.updated_at)) as last_at
    from public.telegram_promotion_queue q left join public.telegram_promotion_v2_message_meta m on m.queue_id=q.id
    where q.language=p_language and q.kind<>'update' and q.status in ('ready','sending','sent','uncertain') and q.created_at>=v_start-interval '14 days'
    group by coalesce(m.topic,q.kind)
  ) t;
  select jsonb_build_object('id',s.id,'main_genre',s.main_genre,'tags',s.tags) into v_similar
  from public.telegram_promotion_queue q join public.stories s on s.id=q.story_id join public.shadow_reader_visible_stories_v1 v on v.id=s.id
  where q.language=p_language and q.kind='update' and q.status='sent' and q.sent_at>=v_start-interval '7 days' and s.status='published' and s.deleted_at is null and s.is_adult is not true and public.telegram_promotion_language_v1(s.story_language)=p_language
  order by q.sent_at desc,q.id limit 1;
  return jsonb_build_object('existingId',v_existing,'updateCount',v_updates,'daytimeCount',v_daytime,'recentTopics',v_topics,'similarStory',v_similar);
end;
$$;

revoke all on function public.telegram_promotion_v2_slot_context(text,text) from public,anon,authenticated;
grant execute on function public.telegram_promotion_v2_slot_context(text,text) to service_role;
commit;
