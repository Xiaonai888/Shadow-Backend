create extension if not exists pg_net;

create or replace function public.wake_shadow_story_episode_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret
  into v_secret
  from vault.decrypted_secrets
  where name = 'story_episode_push_wake_token'
  order by created_at desc
  limit 1;

  if length(coalesce(v_secret, '')) < 32 then
    return new;
  end if;

  perform net.http_post(
    url := 'https://shadow-backend-kucw.onrender.com/api/story-episode-push/wake',
    body := jsonb_build_object('job_id', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-shadow-story-push-wake', v_secret
    ),
    timeout_milliseconds := 3000
  );

  return new;
exception when others then
  raise warning 'Story push wake failed for job %: %', new.id, sqlerrm;
  return new;
end;
$$;

revoke execute on function public.wake_shadow_story_episode_push()
from public, anon, authenticated;

drop trigger if exists story_episode_push_wake_after_insert
on public.story_episode_push_jobs;

create trigger story_episode_push_wake_after_insert
after insert on public.story_episode_push_jobs
for each row
execute function public.wake_shadow_story_episode_push();

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
