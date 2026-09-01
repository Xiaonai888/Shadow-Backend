create or replace function public.get_author_dashboard_content_summary(
  p_author_page_id uuid
)
returns table (
  posts bigint,
  stories bigint,
  episodes bigint,
  post_likes bigint,
  post_comments bigint,
  post_echoes bigint,
  story_views bigint,
  story_likes bigint,
  story_comments bigint
)
language sql
security definer
set search_path = public
as $$
  with post_stats as (
    select
      count(*)::bigint as posts,
      coalesce(sum(like_count), 0)::bigint as post_likes,
      coalesce(sum(comment_count), 0)::bigint as post_comments,
      coalesce(sum(echo_count), 0)::bigint as post_echoes
    from public.author_page_posts
    where author_page_id = p_author_page_id
      and status = 'active'
  ),
  story_stats as (
    select
      count(*)::bigint as stories,
      coalesce(sum(total_episodes), 0)::bigint as episodes,
      coalesce(sum(total_views), 0)::bigint as story_views,
      coalesce(sum(total_likes), 0)::bigint as story_likes,
      coalesce(sum(total_comments), 0)::bigint as story_comments
    from public.stories
    where author_id = p_author_page_id
      and status = 'published'
      and deleted_at is null
  )
  select
    post_stats.posts,
    story_stats.stories,
    story_stats.episodes,
    post_stats.post_likes,
    post_stats.post_comments,
    post_stats.post_echoes,
    story_stats.story_views,
    story_stats.story_likes,
    story_stats.story_comments
  from post_stats
  cross join story_stats;
$$;

revoke all on function public.get_author_dashboard_content_summary(uuid) from public;
grant execute on function public.get_author_dashboard_content_summary(uuid) to service_role;

create or replace function public.get_author_dashboard_recent_comments(
  p_author_page_id uuid,
  p_limit integer default 3
)
returns table (
  comment jsonb,
  post jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    jsonb_build_object(
      'id', c.id,
      'post_id', c.post_id,
      'user_id', c.user_id,
      'text', c.text,
      'created_at', c.created_at,
      'user',
        case
          when u.id is null then null
          else jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'username', u.username,
            'avatar_url', u.avatar_url
          )
        end
    ) as comment,
    jsonb_build_object(
      'id', p.id,
      'content', p.content,
      'image_urls', p.image_urls,
      'like_count', p.like_count,
      'comment_count', p.comment_count,
      'echo_count', p.echo_count,
      'created_at', p.created_at,
      'updated_at', p.updated_at
    ) as post
  from public.author_page_post_comments c
  join public.author_page_posts p
    on p.id = c.post_id
  left join public.users u
    on u.id = c.user_id
  where p.author_page_id = p_author_page_id
    and p.status = 'active'
    and c.is_hidden = false
    and c.parent_id is null
    and c.deleted_at is null
  order by c.created_at desc
  limit greatest(1, least(coalesce(p_limit, 3), 10));
$$;

revoke all on function public.get_author_dashboard_recent_comments(uuid, integer) from public;
grant execute on function public.get_author_dashboard_recent_comments(uuid, integer) to service_role;


create index if not exists author_page_post_comments_recent_dashboard_idx
  on public.author_page_post_comments (created_at desc, post_id)
  where is_hidden = false
    and parent_id is null
    and deleted_at is null;
