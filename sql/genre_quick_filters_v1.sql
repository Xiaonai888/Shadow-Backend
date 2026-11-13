create index if not exists idx_genre_quick_episodes_published
on public.episodes (story_id, first_published_at, episode_number)
where status = 'published' and deleted_at is null;

create index if not exists idx_genre_quick_stories_language_updated
on public.stories (story_language, updated_at desc, id desc)
where status = 'published' and deleted_at is null;

create or replace function public.get_genre_quick_story_ids_v1(
  p_mode text,
  p_language text default '',
  p_story_setting text default '',
  p_story_type text default '',
  p_story_status text default '',
  p_genre text default '',
  p_relationship_group text default '',
  p_search text default '',
  p_can_view_adult boolean default false,
  p_cursor_time timestamptz default null,
  p_cursor_id uuid default null
)
returns table (
  story_id uuid,
  sort_at timestamptz,
  next_wait_free_at timestamptz,
  published_episode_count bigint,
  free_episode_count bigint,
  is_fully_free boolean,
  has_wait_free_episode boolean
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if p_mode not in ('wait_free', 'fully_free', 'completed') then
    raise exception 'Invalid genre quick filter';
  end if;

  return query
  with eligible as (
    select
      s.id,
      coalesce(s.updated_at, s.created_at, 'epoch'::timestamptz) as last_updated_at,
      lower(trim(coalesce(s.story_status, ''))) = 'completed' as is_completed,
      access_stats.published_count,
      access_stats.free_count,
      access_stats.next_free_at
    from public.stories s
    cross join lateral (
      select
        count(*)::bigint as published_count,
        count(*) filter (
          where episode_rank <= 5
            or coalesce(is_free_published, false)
            or not coalesce(is_locked, false)
        )::bigint as free_count,
        min(coalesce(first_published_at, published_at, created_at, 'epoch'::timestamptz) + interval '7 days') filter (
          where episode_rank > 5
            and coalesce(is_locked, false)
            and not coalesce(is_free_published, false)
        ) as next_free_at
      from (
        select
          e.first_published_at,
          e.published_at,
          e.created_at,
          e.is_locked,
          e.is_free_published,
          row_number() over (
            order by
              coalesce(e.first_published_at, 'epoch'::timestamptz),
              e.episode_number,
              e.created_at,
              e.id
          ) as episode_rank
        from public.episodes e
        where e.story_id = s.id
          and e.status = 'published'
          and e.deleted_at is null
          and (e.first_published_at is null or e.first_published_at <= now())
      ) ranked_episodes
    ) access_stats
    where s.status = 'published'
      and s.deleted_at is null
      and coalesce(s.is_shadow_exclusive, false) = false
      and (p_can_view_adult or not coalesce(s.is_adult, false))
      and (coalesce(p_language, '') = '' or s.story_language = p_language)
      and (
        coalesce(p_story_setting, '') = ''
        or to_jsonb(s.story_settings) @> jsonb_build_array(p_story_setting)
      )
      and (
        coalesce(p_story_type, '') = ''
        or s.story_type = p_story_type
      )
      and (
        coalesce(p_story_status, '') = ''
        or lower(s.story_status) = lower(p_story_status)
      )
      and (
        coalesce(p_genre, '') = ''
        or (
          coalesce(p_relationship_group, '') <> ''
          and to_jsonb(s.relationship_groups) @> jsonb_build_array(p_relationship_group)
        )
        or (
          coalesce(p_relationship_group, '') = ''
          and (
            lower(s.main_genre) = lower(p_genre)
            or exists (
              select 1
              from jsonb_array_elements_text(
                case
                  when jsonb_typeof(to_jsonb(s.tags)) = 'array' then to_jsonb(s.tags)
                  else '[]'::jsonb
                end
              ) as story_tag(tag)
              where lower(ltrim(story_tag.tag, '#')) = lower(ltrim(p_genre, '#'))
            )
          )
        )
      )
      and (
        coalesce(p_search, '') = ''
        or s.title ilike '%' || p_search || '%'
        or s.description ilike '%' || p_search || '%'
        or s.main_genre ilike '%' || p_search || '%'
        or exists (
          select 1
          from jsonb_array_elements_text(
            case
              when jsonb_typeof(to_jsonb(s.tags)) = 'array' then to_jsonb(s.tags)
              else '[]'::jsonb
            end
          ) as search_tag(tag)
          where search_tag.tag ilike '%' || p_search || '%'
        )
      )
  ), ranked as (
    select
      eligible.id as ranked_story_id,
      case
        when p_mode = 'wait_free' then eligible.next_free_at
        else eligible.last_updated_at
      end as ranked_sort_at,
      eligible.next_free_at as ranked_next_free_at,
      eligible.published_count as ranked_published_count,
      eligible.free_count as ranked_free_count,
      eligible.is_completed and eligible.published_count > 0
        and eligible.free_count = eligible.published_count as ranked_fully_free,
      eligible.next_free_at is not null as ranked_wait_free
    from eligible
    where (
      (p_mode = 'wait_free' and eligible.next_free_at is not null)
      or (p_mode = 'fully_free' and eligible.is_completed
          and eligible.published_count > 0
          and eligible.free_count = eligible.published_count)
      or (p_mode = 'completed' and eligible.is_completed)
    )
  )
  select
    ranked.ranked_story_id,
    ranked.ranked_sort_at,
    ranked.ranked_next_free_at,
    ranked.ranked_published_count,
    ranked.ranked_free_count,
    ranked.ranked_fully_free,
    ranked.ranked_wait_free
  from ranked
  where p_cursor_time is null
    or (
      p_mode = 'wait_free'
      and (
        ranked.ranked_sort_at > p_cursor_time
        or (ranked.ranked_sort_at = p_cursor_time and ranked.ranked_story_id < p_cursor_id)
      )
    )
    or (
      p_mode <> 'wait_free'
      and (
        ranked.ranked_sort_at < p_cursor_time
        or (ranked.ranked_sort_at = p_cursor_time and ranked.ranked_story_id < p_cursor_id)
      )
    )
  order by
    case when p_mode = 'wait_free' then ranked.ranked_sort_at end asc nulls last,
    case when p_mode <> 'wait_free' then ranked.ranked_sort_at end desc nulls last,
    ranked.ranked_story_id desc
  limit 10;
end;
$$;

revoke all on function public.get_genre_quick_story_ids_v1(
  text, text, text, text, text, text, text, text, boolean, timestamptz, uuid
) from public, anon, authenticated;

grant execute on function public.get_genre_quick_story_ids_v1(
  text, text, text, text, text, text, text, text, boolean, timestamptz, uuid
) to service_role;
