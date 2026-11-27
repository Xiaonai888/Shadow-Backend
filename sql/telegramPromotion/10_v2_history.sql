begin;

create or replace view public.telegram_promotion_v2_exposure_history
with (security_invoker=true) as
select q.language,q.id as queue_id,q.story_id,q.kind,q.status,q.sent_at,q.updated_at,
       coalesce(m.topic,q.kind) as topic,m.caption_id
from public.telegram_promotion_queue q
left join public.telegram_promotion_v2_message_meta m on m.queue_id=q.id
where q.kind<>'update' and q.status in ('ready','sending','sent','uncertain')
union all
select q.language,q.id,g.story_id,q.kind,q.status,q.sent_at,q.updated_at,
       coalesce(m.topic,q.kind),m.caption_id
from public.telegram_promotion_v2_group_stories g
join public.telegram_promotion_v2_message_meta m on m.queue_id=g.queue_id and m.post_type='group'
join public.telegram_promotion_queue q on q.id=g.queue_id
where q.kind<>'update' and q.status in ('ready','sending','sent','uncertain') and g.story_id<>q.story_id;

create or replace view public.telegram_promotion_v2_caption_history
with (security_invoker=true) as
select q.language,q.id as queue_id,m.topic,m.caption_id,q.status,q.sent_at,q.updated_at
from public.telegram_promotion_v2_message_meta m
join public.telegram_promotion_queue q on q.id=m.queue_id
where m.caption_id is not null and q.status in ('ready','sending','sent','uncertain');

create or replace view public.telegram_promotion_v2_update_totals
with (security_invoker=true) as
select g.language,g.story_id,g.local_day,g.group_no,g.queue_id,g.first_episode_id,g.first_published_at,
       g.desired_revision,g.applied_revision,
       count(e.episode_id)::integer as group_episode_count,
       (sum(count(e.episode_id)) over (partition by g.language,g.story_id,g.local_day order by g.group_no rows between unbounded preceding and current row))::integer as total_today,
       greatest(0,(sum(count(e.episode_id)) over (partition by g.language,g.story_id,g.local_day order by g.group_no rows between unbounded preceding and current row))::integer-1) as up_count
from public.telegram_promotion_v2_update_groups g
left join public.telegram_promotion_v2_update_episodes e on (e.language,e.story_id,e.local_day,e.group_no)=(g.language,g.story_id,g.local_day,g.group_no)
group by g.language,g.story_id,g.local_day,g.group_no,g.queue_id,g.first_episode_id,g.first_published_at,g.desired_revision,g.applied_revision;

revoke all on public.telegram_promotion_v2_exposure_history,public.telegram_promotion_v2_caption_history,public.telegram_promotion_v2_update_totals from public,anon,authenticated;
grant select on public.telegram_promotion_v2_exposure_history,public.telegram_promotion_v2_caption_history,public.telegram_promotion_v2_update_totals to service_role;

commit;
