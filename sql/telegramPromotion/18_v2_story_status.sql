begin;

create table if not exists public.telegram_promotion_v2_story_completion (
  story_id uuid primary key references public.stories(id) on delete cascade,
  completed_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.telegram_promotion_v2_story_completion enable row level security;
revoke all on public.telegram_promotion_v2_story_completion from public,anon,authenticated;
grant select,insert,update,delete on public.telegram_promotion_v2_story_completion to service_role;

create or replace function public.telegram_promotion_v2_capture_completion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if lower(coalesce(old.story_status,'')) is distinct from lower(coalesce(new.story_status,'')) then
    if lower(coalesce(new.story_status,''))='completed' then
      insert into public.telegram_promotion_v2_story_completion(story_id,completed_at,updated_at)
      values(new.id,now(),now()) on conflict(story_id) do update set completed_at=excluded.completed_at,updated_at=excluded.updated_at;
    else
      delete from public.telegram_promotion_v2_story_completion where story_id=new.id;
    end if;
  end if;
  return new;
exception when others then
  raise warning 'TELEGRAM_PROMOTION_COMPLETION_CAPTURE_FAILED: %',sqlstate;
  return new;
end;
$$;
drop trigger if exists telegram_promotion_v2_capture_story_completion on public.stories;
create trigger telegram_promotion_v2_capture_story_completion after update of story_status on public.stories for each row execute function public.telegram_promotion_v2_capture_completion();

create or replace function public.telegram_promotion_v2_story_status(p_story_id uuid,p_episode_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('storyId',s.id,'episodeId',e.id,
 'firstEpisode',not exists(select 1 from public.episodes f where f.story_id=s.id and (f.first_published_at is not null or f.status='published') and coalesce(f.first_published_at,f.published_at) is not null and (coalesce(f.first_published_at,f.published_at),f.id)<(coalesce(e.first_published_at,e.published_at),e.id)),
 'justCompleted',coalesce(lower(s.story_status)='completed' and (c.completed_at at time zone 'Asia/Phnom_Penh')::date=(coalesce(e.first_published_at,e.published_at) at time zone 'Asia/Phnom_Penh')::date and not exists(select 1 from public.episodes l where l.story_id=s.id and l.status='published' and l.deleted_at is null and coalesce(l.first_published_at,l.published_at)<=now() and (l.published_at is null or l.published_at<=now()) and (l.scheduled_at is null or l.scheduled_at<=now()) and (coalesce(l.first_published_at,l.published_at),l.id)>(coalesce(e.first_published_at,e.published_at),e.id)),false))
from public.stories s join public.episodes e on e.story_id=s.id and e.id=p_episode_id
left join public.telegram_promotion_v2_story_completion c on c.story_id=s.id
where s.id=p_story_id and s.status='published' and s.deleted_at is null and e.status='published' and e.deleted_at is null and coalesce(e.first_published_at,e.published_at)<=now() and (e.published_at is null or e.published_at<=now()) and (e.scheduled_at is null or e.scheduled_at<=now());
$$;
revoke all on function public.telegram_promotion_v2_capture_completion(),public.telegram_promotion_v2_story_status(uuid,uuid) from public,anon,authenticated;
grant execute on function public.telegram_promotion_v2_story_status(uuid,uuid) to service_role;
commit;
