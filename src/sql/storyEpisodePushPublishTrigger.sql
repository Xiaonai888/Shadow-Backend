create or replace function public.capture_story_episode_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from 'published'
     or new.published_at is null
     or new.deleted_at is not null then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status = 'published' then
    return new;
  end if;

  insert into public.story_episode_push_jobs (
    story_id,
    episode_id,
    published_at,
    available_at
  )
  values (
    new.story_id,
    new.id,
    new.published_at,
    greatest(now(), new.published_at)
  )
  on conflict (episode_id) do nothing;

  return new;
exception when others then
  raise warning 'Episode push queue failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists story_episode_push_after_insert on public.episodes;

create trigger story_episode_push_after_insert
after insert on public.episodes
for each row
execute function public.capture_story_episode_push();

drop trigger if exists story_episode_push_after_publish on public.episodes;

create trigger story_episode_push_after_publish
after update of status, published_at on public.episodes
for each row
execute function public.capture_story_episode_push();
