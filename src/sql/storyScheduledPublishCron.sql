create extension if not exists pg_cron with schema pg_catalog;

create index if not exists episodes_due_scheduled_release_idx
on public.episodes (scheduled_at, id)
where status = 'scheduled'
  and deleted_at is null
  and scheduled_at is not null;

create or replace function public.publish_due_shadow_story_episodes(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_count integer := 0;
begin
  if p_limit < 1 or p_limit > 500 then
    raise exception 'Invalid episode release limit';
  end if;

  select coalesce(array_agg(d.id), '{}'::uuid[])
  into v_ids
  from (
    select e.id
    from public.episodes e
    join public.stories s on s.id = e.story_id
    where e.status = 'scheduled'
      and e.scheduled_at is not null
      and e.scheduled_at <= now()
      and e.deleted_at is null
      and s.deleted_at is null
      and s.status in ('draft', 'published')
    order by e.scheduled_at, e.id
    for update of e skip locked
    limit p_limit
  ) d;

  if cardinality(v_ids) = 0 then
    return 0;
  end if;

  update public.stories s
  set status = 'published',
      updated_at = now()
  where s.status = 'draft'
    and s.deleted_at is null
    and exists (
      select 1
      from public.episodes e
      where e.id = any(v_ids)
        and e.story_id = s.id
    );

  update public.episodes e
  set status = 'published',
      published_at = e.scheduled_at,
      first_published_at = coalesce(e.first_published_at, e.scheduled_at),
      scheduled_at = null,
      updated_at = now()
  where e.id = any(v_ids)
    and e.status = 'scheduled'
    and e.scheduled_at <= now()
    and e.deleted_at is null
    and exists (
      select 1
      from public.stories s
      where s.id = e.story_id
        and s.status = 'published'
        and s.deleted_at is null
    );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.publish_due_shadow_story_episodes(integer)
from public, anon, authenticated;

grant execute on function public.publish_due_shadow_story_episodes(integer)
to service_role;

select cron.schedule(
  'shadow-story-scheduled-episode-release',
  '* * * * *',
  'select public.publish_due_shadow_story_episodes(100)'
);
