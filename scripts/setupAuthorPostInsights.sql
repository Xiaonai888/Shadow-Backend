create or replace function public.record_author_post_view(
  p_post_id text,
  p_viewer_user_id text default null,
  p_viewer_key text default null,
  p_source text default 'direct'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post record;
  v_was_following boolean := false;
  v_source text := lower(coalesce(nullif(trim(p_source), ''), 'direct'));
  v_viewer_key text := nullif(trim(p_viewer_key), '');
begin
  if nullif(trim(p_post_id), '') is null or v_viewer_key is null then
    return false;
  end if;

  select
    id,
    user_id,
    author_page_id
  into v_post
  from public.author_page_posts
  where id::text = p_post_id
    and status = 'active'
  limit 1;

  if not found then
    return false;
  end if;

  if p_viewer_user_id is not null
    and v_post.user_id::text = p_viewer_user_id then
    return false;
  end if;

  if exists (
    select 1
    from public.author_page_post_views
    where post_id::text = v_post.id::text
      and viewer_key = v_viewer_key
      and viewed_at >= now() - interval '30 minutes'
  ) then
    return false;
  end if;

  if p_viewer_user_id is not null then
    select exists (
      select 1
      from public.author_page_follows
      where author_page_id::text = v_post.author_page_id::text
        and follower_user_id::text = p_viewer_user_id
    )
    into v_was_following;
  end if;

  if v_source not in (
    'feed',
    'suggested',
    'follower_feed',
    'author_page',
    'discover',
    'search',
    'share',
    'notification',
    'direct',
    'other'
  ) then
    v_source := 'other';
  end if;

  with typed_values as (
    select jsonb_populate_record(
      null::public.author_page_post_views,
      jsonb_build_object(
        'post_id', v_post.id::text,
        'viewer_user_id', nullif(trim(p_viewer_user_id), '')
      )
    ) as row_value
  )
  insert into public.author_page_post_views (
    post_id,
    viewer_user_id,
    viewer_key,
    source,
    was_following
  )
  select
    (row_value).post_id,
    (row_value).viewer_user_id,
    v_viewer_key,
    v_source,
    v_was_following
  from typed_values;

  return true;
end;
$$;

revoke all on function public.record_author_post_view(text, text, text, text) from public;
grant execute on function public.record_author_post_view(text, text, text, text) to service_role;
