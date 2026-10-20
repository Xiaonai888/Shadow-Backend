begin;

alter table public.reader_library_notification_preferences
  alter column master set default false,
  alter column novel set default false,
  alter column chat_story set default false,
  alter column manga set default false;

create or replace function public.eligible_story_episode_push_users(p_batch_id uuid)
returns uuid[]
language sql
security definer
set search_path = ''
as $$
  select coalesce(array_agg(r.user_id order by r.user_id), '{}'::uuid[])
  from public.story_episode_push_batches b
  join public.story_episode_push_jobs j on j.id = b.job_id
  join public.episodes e on e.id = j.episode_id and e.story_id = j.story_id
  join public.stories s on s.id = j.story_id
  join public.reader_subscriptions r
    on r.story_id = j.story_id and r.user_id = any(b.recipient_user_ids)
  left join public.reader_library_notification_preferences p on p.user_id = r.user_id
  where b.id = p_batch_id
    and b.status = 'processing'
    and j.status = 'processing'
    and r.created_at <= j.published_at
    and e.status = 'published'
    and e.deleted_at is null
    and e.published_at <= now()
    and s.status = 'published'
    and s.deleted_at is null
    and coalesce(p.master, false)
    and case
      when lower(trim(coalesce(s.story_type::text, ''))) = 'manga' then coalesce(p.manga, false)
      when lower(trim(coalesce(s.story_type::text, ''))) in ('chat_story', 'chatstory', 'chat story') then coalesce(p.chat_story, false)
      else coalesce(p.novel, false)
    end;
$$;

create unique index if not exists notifications_episode_updates_unique_idx
  on public.notifications (user_id, reference_id)
  where type = 'announcements' and reference_id like 'episode-update:%' and deleted_at is null;

create or replace function public.record_story_episode_notification_batch(p_batch_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer := 0;
begin
  insert into public.notifications (user_id, type, title, message, image_url, link, reference_id, is_read)
  select
    recipient.user_id,
    'announcements',
    '📖 ' || left(coalesce(s.title, 'Shadow'), 100),
    'ភាគទី ' || coalesce(e.episode_number::text, '0') || ' បានចេញផ្សាយហើយ! ចុចដើម្បីអានឥឡូវនេះ។',
    '',
    '/story/' || j.story_id::text || '/episode/' || j.episode_id::text,
    'episode-update:' || j.episode_id::text,
    false
  from public.story_episode_push_batches b
  join public.story_episode_push_jobs j on j.id = b.job_id
  join public.episodes e on e.id = j.episode_id and e.story_id = j.story_id
  join public.stories s on s.id = j.story_id
  cross join lateral unnest(public.eligible_story_episode_push_users(p_batch_id)) as recipient(user_id)
  where b.id = p_batch_id
    and b.status = 'processing'
    and j.status = 'processing'
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function public.eligible_story_episode_push_users(uuid) from public, anon, authenticated;
grant execute on function public.eligible_story_episode_push_users(uuid) to service_role;
revoke all on function public.record_story_episode_notification_batch(uuid) from public, anon, authenticated;
grant execute on function public.record_story_episode_notification_batch(uuid) to service_role;

commit;
