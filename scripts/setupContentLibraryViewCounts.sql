create or replace function public.get_author_post_view_counts(
  p_post_ids text[]
)
returns table (
  post_id text,
  view_count bigint
)
language sql
security definer
set search_path = public
as $$
  select
    views.post_id::text as post_id,
    count(*)::bigint as view_count
  from public.author_page_post_views as views
  where views.post_id::text = any(p_post_ids)
  group by views.post_id::text;
$$;

revoke all on function public.get_author_post_view_counts(text[]) from public;
grant execute on function public.get_author_post_view_counts(text[]) to service_role;
