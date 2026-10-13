create or replace function public.reader_library_feed_page(
  p_user_id uuid,
  p_tab text default 'recents',
  p_type text default 'all',
  p_cursor_score integer default null,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null,
  p_include_adult boolean default false
)
returns table (
  collection_id uuid,
  story_id uuid,
  saved_at timestamptz,
  last_read_at timestamptz,
  unread_count integer,
  last_episode_at timestamptz,
  sort_score integer,
  sort_at timestamptz,
  title text,
  cover_url text,
  story_type text,
  main_genre text,
  story_status text,
  total_episodes integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_tab not in ('recents', 'subscribed') or p_type not in ('all', 'novel', 'manga', 'chat_story') then
    raise exception 'Invalid library feed parameters' using errcode = '22023';
  end if;

  if p_cursor_id is not null and (p_cursor_score is null or p_cursor_at is null) then
    raise exception 'Invalid library feed cursor' using errcode = '22023';
  end if;

  if p_tab = 'recents' then
    return query
    with ranked as (
      select
        rl.id as collection_id,
        rl.story_id,
        rl.created_at as saved_at,
        rp.last_read_at,
        0::integer as unread_count,
        null::timestamptz as last_episode_at,
        case when rp.last_read_at is not null then 1 else 0 end::integer as sort_score,
        coalesce(rp.last_read_at, rl.created_at) as sort_at,
        s.title::text as title,
        coalesce(s.cover_url, '')::text as cover_url,
        coalesce(s.story_type, 'novel')::text as story_type,
        coalesce(s.main_genre, '')::text as main_genre,
        coalesce(s.story_status, 'New')::text as story_status,
        coalesce(s.total_episodes, 0)::integer as total_episodes
      from public.reader_library rl
      join public.stories s on s.id = rl.story_id
      left join public.reading_progress rp on rp.user_id = rl.user_id and rp.story_id = rl.story_id
      where rl.user_id = p_user_id
        and s.status = 'published'
        and s.deleted_at is null
        and (p_include_adult or coalesce(s.is_adult, false) = false)
        and (p_type = 'all' or coalesce(s.story_type, 'novel') = p_type)
    )
    select
      r.collection_id, r.story_id, r.saved_at, r.last_read_at,
      r.unread_count, r.last_episode_at, r.sort_score, r.sort_at,
      r.title, r.cover_url, r.story_type, r.main_genre,
      r.story_status, r.total_episodes
    from ranked r
    where p_cursor_id is null
      or (r.sort_score, r.sort_at, r.story_id) < (p_cursor_score, p_cursor_at, p_cursor_id)
    order by r.sort_score desc, r.sort_at desc, r.story_id desc
    limit 10;
    return;
  end if;

  return query
  with ranked as (
    select
      rs.id as collection_id,
      rs.story_id,
      rs.created_at as saved_at,
      rp.last_read_at,
      coalesce(updates.unread_count, 0)::integer as unread_count,
      updates.last_episode_at,
      coalesce(updates.unread_count, 0)::integer as sort_score,
      coalesce(updates.last_episode_at, rs.created_at) as sort_at,
      s.title::text as title,
      coalesce(s.cover_url, '')::text as cover_url,
      coalesce(s.story_type, 'novel')::text as story_type,
      coalesce(s.main_genre, '')::text as main_genre,
      coalesce(s.story_status, 'New')::text as story_status,
      coalesce(s.total_episodes, 0)::integer as total_episodes
    from public.reader_subscriptions rs
    join public.stories s on s.id = rs.story_id
    left join public.reading_progress rp on rp.user_id = rs.user_id and rp.story_id = rs.story_id
    left join lateral (
      select
        count(*)::integer as unread_count,
        max(coalesce(e.published_at, e.created_at)) as last_episode_at
      from public.episodes e
      where e.story_id = rs.story_id
        and e.status = 'published'
        and e.deleted_at is null
        and coalesce(e.published_at, e.created_at) <= now()
        and (
          (rp.episode_number is not null and e.episode_number > rp.episode_number)
          or (rp.episode_number is null and coalesce(e.published_at, e.created_at) > rs.created_at)
        )
    ) updates on true
    where rs.user_id = p_user_id
      and s.status = 'published'
      and s.deleted_at is null
      and (p_include_adult or coalesce(s.is_adult, false) = false)
      and (p_type = 'all' or coalesce(s.story_type, 'novel') = p_type)
  )
  select
    r.collection_id, r.story_id, r.saved_at, r.last_read_at,
    r.unread_count, r.last_episode_at, r.sort_score, r.sort_at,
    r.title, r.cover_url, r.story_type, r.main_genre,
    r.story_status, r.total_episodes
  from ranked r
  where r.unread_count > 0
    and (
      p_cursor_id is null
      or (r.sort_score, r.sort_at, r.story_id) < (p_cursor_score, p_cursor_at, p_cursor_id)
    )
  order by r.sort_score desc, r.sort_at desc, r.story_id desc
  limit 10;
end;
$$;

create or replace function public.reader_library_unread_counts(
  p_user_id uuid,
  p_include_adult boolean default false
)
returns table (story_type text, story_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  with unread as (
    select coalesce(s.story_type, 'novel')::text as kind
    from public.reader_subscriptions rs
    join public.stories s on s.id = rs.story_id
    left join public.reading_progress rp on rp.user_id = rs.user_id and rp.story_id = rs.story_id
    where rs.user_id = p_user_id
      and s.status = 'published'
      and s.deleted_at is null
      and (p_include_adult or coalesce(s.is_adult, false) = false)
      and exists (
        select 1
        from public.episodes e
        where e.story_id = rs.story_id
          and e.status = 'published'
          and e.deleted_at is null
          and coalesce(e.published_at, e.created_at) <= now()
          and (
            (rp.episode_number is not null and e.episode_number > rp.episode_number)
            or (rp.episode_number is null and coalesce(e.published_at, e.created_at) > rs.created_at)
          )
      )
  )
  select 'all'::text, count(*)::bigint from unread
  union all
  select u.kind, count(*)::bigint from unread u group by u.kind;
$$;

revoke all on function public.reader_library_feed_page(uuid, text, text, integer, timestamptz, uuid, boolean) from public, anon, authenticated;
grant execute on function public.reader_library_feed_page(uuid, text, text, integer, timestamptz, uuid, boolean) to service_role;
revoke all on function public.reader_library_unread_counts(uuid, boolean) from public, anon, authenticated;
grant execute on function public.reader_library_unread_counts(uuid, boolean) to service_role;
