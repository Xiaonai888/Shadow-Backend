create or replace function public.record_author_post_views_batch(
  p_post_ids text[],
  p_viewer_user_id text default null,
  p_viewer_key text default null,
  p_source text default 'direct'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post_id text;
  v_recorded boolean;
  v_recorded_count integer := 0;
begin
  if p_post_ids is null or coalesce(array_length(p_post_ids, 1), 0) = 0 then
    return 0;
  end if;

  for v_post_id in
    select distinct nullif(trim(item), '')
    from unnest(p_post_ids) as items(item)
    where nullif(trim(item), '') is not null
    limit 50
  loop
    select public.record_author_post_view(
      v_post_id,
      p_viewer_user_id,
      p_viewer_key,
      p_source
    )
    into v_recorded;

    if coalesce(v_recorded, false) then
      v_recorded_count := v_recorded_count + 1;
    end if;
  end loop;

  return v_recorded_count;
end;
$$;

revoke all on function public.record_author_post_views_batch(text[], text, text, text) from public;
grant execute on function public.record_author_post_views_batch(text[], text, text, text) to service_role;
