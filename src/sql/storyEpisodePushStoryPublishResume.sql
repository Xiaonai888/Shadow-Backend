create or replace function public.resume_story_episode_push_after_story_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from 'published'
     or new.deleted_at is not null
     or old.status is not distinct from new.status then
    return new;
  end if;

  update public.story_episode_push_jobs j
  set available_at = now(),
      updated_at = now()
  where j.story_id = new.id
    and j.status in ('queued', 'processing')
    and j.subscribers_prepared = false
    and j.available_at > now();

  return new;
end;
$$;

revoke execute on function public.resume_story_episode_push_after_story_publish()
from public, anon, authenticated;

drop trigger if exists story_episode_push_story_publish_resume
on public.stories;

create trigger story_episode_push_story_publish_resume
after update of status on public.stories
for each row
execute function public.resume_story_episode_push_after_story_publish();
