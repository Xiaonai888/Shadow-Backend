begin;

create table if not exists public.reader_library_notification_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  master boolean not null default true,
  novel boolean not null default true,
  chat_story boolean not null default true,
  manga boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.reader_library_notification_preferences enable row level security;

revoke all on public.reader_library_notification_preferences from public, anon, authenticated;
grant all on public.reader_library_notification_preferences to service_role;

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
  left join public.reader_library_notification_preferences p
    on p.user_id = r.user_id
  where b.id = p_batch_id
    and b.status = 'processing'
    and j.status = 'processing'
    and r.created_at <= j.published_at
    and e.status = 'published'
    and e.deleted_at is null
    and e.published_at <= now()
    and s.status = 'published'
    and s.deleted_at is null
    and coalesce(p.master, true)
    and case
      when lower(trim(coalesce(s.story_type::text, ''))) = 'manga' then coalesce(p.manga, true)
      when lower(trim(coalesce(s.story_type::text, ''))) in ('chat_story', 'chatstory', 'chat story') then coalesce(p.chat_story, true)
      else coalesce(p.novel, true)
    end;
$$;

revoke all on function public.eligible_story_episode_push_users(uuid) from public, anon, authenticated;
grant execute on function public.eligible_story_episode_push_users(uuid) to service_role;

commit;
