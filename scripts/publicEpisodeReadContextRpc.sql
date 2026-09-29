create or replace function public.get_public_episode_read_context_v1(
  p_user_id uuid,
  p_story_id uuid,
  p_episode_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_story public.stories%rowtype;
  v_author_page jsonb;
  v_result jsonb;
begin
  select s.*
  into v_story
  from public.stories s
  where s.id = p_story_id
    and s.status = 'published'
    and s.deleted_at is null
  limit 1;

  if v_story.id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'STORY_NOT_FOUND'
    );
  end if;

  if coalesce(v_story.is_shadow_exclusive, false)
    and coalesce(v_story.exclusive_status, '') <> 'approved'
  then
    return jsonb_build_object(
      'ok', false,
      'code', 'STORY_NOT_FOUND'
    );
  end if;

  select to_jsonb(ap)
  into v_author_page
  from public.author_pages ap
  where ap.id = v_story.author_id
  limit 1;

  with active as (
    select
      e.id,
      row_number() over (
        order by
          e.episode_number asc,
          e.created_at asc,
          e.id asc
      )::integer as current_episode_number
    from public.episodes e
    where e.story_id = p_story_id
      and e.deleted_at is null
  ),
  published as (
    select
      e.*,
      row_number() over (
        order by
          coalesce(
            e.first_published_at,
            '-infinity'::timestamptz
          ) asc,
          e.episode_number asc,
          e.created_at asc,
          e.id asc
      )::integer as published_rank
    from public.episodes e
    where e.story_id = p_story_id
      and e.deleted_at is null
      and lower(trim(coalesce(e.status, ''))) = 'published'
      and (
        e.first_published_at is null
        or e.first_published_at <= now()
      )
  ),
  target as (
    select
      p.*,
      a.current_episode_number
    from published p
    left join active a
      on a.id = p.id
    where p.id = p_episode_id
    limit 1
  ),
  free_ids as (
    select
      p.id,
      p.published_rank
    from published p
    where p.published_rank <= 5
      or coalesce(p.is_free_published, false)
  )
  select jsonb_build_object(
    'ok', true,
    'story', to_jsonb(v_story),
    'author_page', v_author_page,
    'episode',
      to_jsonb(t)
      - 'published_rank'
      - 'current_episode_number',
    'current_episode_number',
      coalesce(
        t.current_episode_number,
        t.episode_number,
        1
      ),
    'published_rank',
      t.published_rank,
    'first_visible_episode_id',
      (
        select p.id
        from published p
        order by p.published_rank asc
        limit 1
      ),
    'free_published_episode_ids',
      coalesce(
        (
          select jsonb_agg(
            f.id
            order by f.published_rank asc
          )
          from free_ids f
        ),
        '[]'::jsonb
      ),
    'free_episode',
      exists(
        select 1
        from free_ids f
        where f.id = p_episode_id
      ),
    'active_unlock',
      case
        when exists(
          select 1
          from free_ids f
          where f.id = p_episode_id
        ) then null
        when p_user_id is null then null
        else (
          select jsonb_build_object(
            'id', u.id,
            'access_type', u.access_type,
            'expires_at', u.expires_at,
            'unlock_status', u.unlock_status
          )
          from public.episode_unlocks u
          where u.user_id = p_user_id
            and u.episode_id = p_episode_id
            and u.unlock_status = 'active'
            and (
              u.expires_at is null
              or u.expires_at > now()
            )
          limit 1
        )
      end
  )
  into v_result
  from target t;

  if v_result is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'EPISODE_NOT_FOUND'
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.get_public_episode_read_context_v1(
  uuid,
  uuid,
  uuid
) from public;

grant execute on function public.get_public_episode_read_context_v1(
  uuid,
  uuid,
  uuid
) to service_role;
