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
set search_path = ''
as $$
begin
  if p_user_id is null
    or p_tab is null
    or p_tab not in ('recents', 'subscribed')
    or p_type is null
    or p_type not in ('all', 'novel', 'manga', 'chat_story')
  then
    raise exception 'Invalid library feed parameters' using errcode = '22023';
  end if;

  if (p_cursor_score is null) <> (p_cursor_at is null)
    or (p_cursor_at is null) <> (p_cursor_id is null)
  then
    raise exception 'Invalid library feed cursor' using errcode = '22023';
  end if;

  if p_tab = 'recents' then
    return query
    with eligible as (
      select
        rl.id as collection_id,
        rl.story_id,
        rl.created_at as saved_at,
        rp.last_read_at,
        case when rp.last_read_at is null then 0 else 1 end::integer as sort_score,
        coalesce(rp.last_read_at, rl.created_at) as sort_at,
        s.title::text,
        coalesce(s.cover_url, '')::text as cover_url,
        s.story_type::text,
        coalesce(s.main_genre, '')::text as main_genre,
        s.story_status::text,
        coalesce(s.total_episodes, 0)::integer as total_episodes
      from public.reader_library rl
      join public.stories s on s.id = rl.story_id
      left join public.reading_progress rp
        on rp.user_id = rl.user_id
       and rp.story_id = rl.story_id
      where rl.user_id = p_user_id
        and s.status = 'published'
        and s.deleted_at is null
        and (p_include_adult or not s.is_adult)
        and (p_type = 'all' or s.story_type = p_type)
    )
    select
      e.collection_id,
      e.story_id,
      e.saved_at,
      e.last_read_at,
      0::integer,
      null::timestamptz,
      e.sort_score,
      e.sort_at,
      e.title,
      e.cover_url,
      e.story_type,
      e.main_genre,
      e.story_status,
      e.total_episodes
    from eligible e
    where p_cursor_id is null
       or (e.sort_score, e.sort_at, e.story_id)
          < (p_cursor_score, p_cursor_at, p_cursor_id)
    order by e.sort_score desc, e.sort_at desc, e.story_id desc
    limit 10;
    return;
  end if;

  return query
  with eligible as materialized (
    select
      rs.id as collection_id,
      rs.story_id,
      rs.created_at as saved_at,
      rp.last_read_at,
      rp.episode_number as last_read_episode_number,
      s.title::text as title,
      coalesce(s.cover_url, '')::text as cover_url,
      s.story_type::text as story_type,
      coalesce(s.main_genre, '')::text as main_genre,
      s.story_status::text as story_status,
      coalesce(s.total_episodes, 0)::integer as total_episodes
    from public.reader_subscriptions rs
    join public.stories s on s.id = rs.story_id
    left join public.reading_progress rp
      on rp.user_id = rs.user_id
     and rp.story_id = rs.story_id
    where rs.user_id = p_user_id
      and s.status = 'published'
      and s.deleted_at is null
      and (p_include_adult or not s.is_adult)
      and (p_type = 'all' or s.story_type = p_type)
  )
  select
    a.collection_id,
    a.story_id,
    a.saved_at,
    a.last_read_at,
    u.unread_count,
    u.last_episode_at,
    u.unread_count,
    coalesce(u.last_episode_at, a.saved_at),
    a.title,
    a.cover_url,
    a.story_type,
    a.main_genre,
    a.story_status,
    a.total_episodes
  from eligible a
  cross join lateral (
    select
      count(*)::integer as unread_count,
      max(coalesce(e.first_published_at, e.published_at, e.created_at)) as last_episode_at
    from public.episodes e
    where e.story_id = a.story_id
      and e.episode_number > coalesce(a.last_read_episode_number, 0)
      and e.status = 'published'
      and e.deleted_at is null
      and coalesce(e.published_at, e.created_at) <= now()
      and (
        a.last_read_episode_number is not null
        or coalesce(e.first_published_at, e.published_at, e.created_at) > a.saved_at
      )
    having count(*) > 0
  ) u
  where p_cursor_id is null
     or (u.unread_count, coalesce(u.last_episode_at, a.saved_at), a.story_id)
        < (p_cursor_score, p_cursor_at, p_cursor_id)
  order by u.unread_count desc,
           coalesce(u.last_episode_at, a.saved_at) desc,
           a.story_id desc
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
set search_path = ''
as $$
  with unread as materialized (
    select s.story_type::text as kind
    from public.reader_subscriptions rs
    join public.stories s on s.id = rs.story_id
    left join public.reading_progress rp
      on rp.user_id = rs.user_id
     and rp.story_id = rs.story_id
    where rs.user_id = p_user_id
      and s.status = 'published'
      and s.deleted_at is null
      and (p_include_adult or not s.is_adult)
      and exists (
        select 1
        from public.episodes e
        where e.story_id = rs.story_id
          and e.episode_number > coalesce(rp.episode_number, 0)
          and e.status = 'published'
          and e.deleted_at is null
          and coalesce(e.published_at, e.created_at) <= now()
          and (
            rp.episode_number is not null
            or coalesce(e.first_published_at, e.published_at, e.created_at) > rs.created_at
          )
      )
  )
  select
    case when grouping(u.kind) = 1 then 'all'::text else u.kind end,
    count(*)::bigint
  from unread u
  group by grouping sets ((), (u.kind));
$$;

revoke all on function public.reader_library_feed_page(uuid, text, text, integer, timestamptz, uuid, boolean) from public, anon, authenticated;
grant execute on function public.reader_library_feed_page(uuid, text, text, integer, timestamptz, uuid, boolean) to service_role;
revoke all on function public.reader_library_unread_counts(uuid, boolean) from public, anon, authenticated;
grant execute on function public.reader_library_unread_counts(uuid, boolean) to service_role;
