drop trigger if exists story_episode_push_wake_after_resume
on public.story_episode_push_jobs;

create trigger story_episode_push_wake_after_resume
after update of available_at
on public.story_episode_push_jobs
for each row
when (
  old.available_at > current_timestamp
  and new.available_at <= current_timestamp
  and new.status in ('queued', 'processing')
)
execute function public.wake_shadow_story_episode_push();
