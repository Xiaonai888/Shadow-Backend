create or replace function public.create_story_comment_once(
  p_story_id uuid,
  p_episode_id uuid,
  p_user_id uuid,
  p_parent_id uuid,
  p_text text,
  p_is_hidden boolean,
  p_client_event_id uuid,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.comments%rowtype;
  v_comment_id uuid;
  v_comment_count bigint;
  v_occurred_at timestamptz;
  v_inserted boolean := false;
begin
  if p_story_id is null or p_user_id is null then
    raise exception 'COMMENT_TARGET_REQUIRED';
  end if;

  if nullif(btrim(coalesce(p_text, '')), '') is null then
    raise exception 'COMMENT_TEXT_REQUIRED';
  end if;

  v_occurred_at := coalesce(p_occurred_at, now());

  if
    v_occurred_at < now() - interval '7 days'
    or v_occurred_at > now() + interval '5 minutes'
  then
    v_occurred_at := now();
  end if;

  if p_client_event_id is not null then
    select *
    into v_existing
    from public.comments
    where user_id = p_user_id
      and client_event_id = p_client_event_id
    limit 1;

    if found then
      if
        v_existing.story_id is distinct from p_story_id
        or v_existing.episode_id is distinct from p_episode_id
        or v_existing.parent_id is distinct from p_parent_id
        or v_existing.text is distinct from btrim(p_text)
      then
        raise exception 'COMMENT_EVENT_CONFLICT';
      end if;

      select coalesce(total_comments, 0)
      into v_comment_count
      from public.stories
      where id = p_story_id;

      return jsonb_build_object(
        'comment_id', v_existing.id,
        'duplicate', true,
        'hidden', coalesce(v_existing.is_hidden, false),
        'occurred_at', coalesce(v_existing.occurred_at, v_existing.created_at),
        'processed_at', coalesce(v_existing.processed_at, v_existing.updated_at, v_existing.created_at),
        'comment_count', coalesce(v_comment_count, 0)
      );
    end if;
  end if;

  begin
    insert into public.comments (
      story_id,
      episode_id,
      user_id,
      parent_id,
      text,
      is_hidden,
      client_event_id,
      occurred_at,
      processed_at,
      created_at
    )
    values (
      p_story_id,
      p_episode_id,
      p_user_id,
      p_parent_id,
      btrim(p_text),
      coalesce(p_is_hidden, false),
      p_client_event_id,
      v_occurred_at,
      now(),
      v_occurred_at
    )
    returning id
    into v_comment_id;

    v_inserted := true;
  exception
    when unique_violation then
      if p_client_event_id is null then
        raise;
      end if;

      select *
      into v_existing
      from public.comments
      where user_id = p_user_id
        and client_event_id = p_client_event_id
      limit 1;

      if not found then
        raise;
      end if;

      if
        v_existing.story_id is distinct from p_story_id
        or v_existing.episode_id is distinct from p_episode_id
        or v_existing.parent_id is distinct from p_parent_id
        or v_existing.text is distinct from btrim(p_text)
      then
        raise exception 'COMMENT_EVENT_CONFLICT';
      end if;

      v_comment_id := v_existing.id;
  end;

  if v_inserted and not coalesce(p_is_hidden, false) then
    update public.stories
    set
      total_comments = greatest(
        0,
        coalesce(total_comments, 0) + 1
      ),
      updated_at = now()
    where id = p_story_id
    returning total_comments
    into v_comment_count;

    if not found then
      raise exception 'STORY_NOT_FOUND';
    end if;
  else
    select coalesce(total_comments, 0)
    into v_comment_count
    from public.stories
    where id = p_story_id;

    if not found then
      raise exception 'STORY_NOT_FOUND';
    end if;
  end if;

  return jsonb_build_object(
    'comment_id', v_comment_id,
    'duplicate', not v_inserted,
    'hidden', coalesce(p_is_hidden, false),
    'occurred_at', v_occurred_at,
    'processed_at', now(),
    'comment_count', coalesce(v_comment_count, 0)
  );
end;
$$;

revoke all
on function public.create_story_comment_once(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  boolean,
  uuid,
  timestamptz
)
from public, anon, authenticated;

grant execute
on function public.create_story_comment_once(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  boolean,
  uuid,
  timestamptz
)
to service_role;
