alter table public.comments
add column if not exists client_event_id uuid;

alter table public.comments
add column if not exists occurred_at timestamptz;

alter table public.comments
add column if not exists processed_at timestamptz;

update public.comments
set occurred_at = coalesce(occurred_at, created_at, now())
where occurred_at is null;

update public.comments
set processed_at = coalesce(processed_at, updated_at, created_at, now())
where processed_at is null;

alter table public.comments
alter column occurred_at set default now();

alter table public.comments
alter column processed_at set default now();

create unique index if not exists comments_user_client_event_unique
on public.comments (
  user_id,
  client_event_id
)
where client_event_id is not null;

create or replace function public.increment_story_comment_total(
  p_story_id uuid,
  p_delta integer
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total bigint;
begin
  update public.stories
  set
    total_comments = greatest(
      0,
      coalesce(total_comments, 0) + coalesce(p_delta, 0)
    ),
    updated_at = now()
  where id = p_story_id
  returning total_comments
  into v_total;

  if not found then
    raise exception 'Story not found';
  end if;

  return coalesce(v_total, 0);
end;
$$;

revoke all
on function public.increment_story_comment_total(uuid, integer)
from public, anon, authenticated;

grant execute
on function public.increment_story_comment_total(uuid, integer)
to service_role;
