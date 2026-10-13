create or replace function public.clear_reader_library_to_trash(
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz := clock_timestamp();
  v_moved integer := 0;
begin
  if p_user_id is null then
    raise exception 'A reader account is required' using errcode = '22023';
  end if;

  with removed as (
    delete from public.reader_library
    where user_id = p_user_id
    returning story_id, created_at
  ), archived as (
    insert into public.reader_library_trash (
      user_id,
      story_id,
      originally_saved_at,
      deleted_at,
      expires_at
    )
    select
      p_user_id,
      removed.story_id,
      removed.created_at,
      v_deleted_at,
      v_deleted_at + interval '30 days'
    from removed
    on conflict (user_id, story_id) do update set
      originally_saved_at = excluded.originally_saved_at,
      deleted_at = excluded.deleted_at,
      expires_at = excluded.expires_at
    returning story_id
  )
  select count(*)::integer into v_moved from archived;

  return v_moved;
end;
$$;

revoke all on function public.clear_reader_library_to_trash(uuid) from public, anon, authenticated;
grant execute on function public.clear_reader_library_to_trash(uuid) to service_role;
