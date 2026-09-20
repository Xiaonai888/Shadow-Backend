create or replace function public.move_reader_library_to_trash(
  p_user_id uuid,
  p_story_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saved_at timestamptz;
  v_deleted_at timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_story_id is null then
    return false;
  end if;

  delete from public.reader_library
  where user_id = p_user_id and story_id = p_story_id
  returning created_at into v_saved_at;

  if not found then
    return false;
  end if;

  insert into public.reader_library_trash (
    user_id, story_id, originally_saved_at, deleted_at, expires_at
  )
  values (
    p_user_id, p_story_id, v_saved_at,
    v_deleted_at, v_deleted_at + interval '30 days'
  )
  on conflict (user_id, story_id) do update set
    originally_saved_at = excluded.originally_saved_at,
    deleted_at = excluded.deleted_at,
    expires_at = excluded.expires_at;

  return true;
end;
$$;

revoke all on function public.move_reader_library_to_trash(uuid, uuid) from public, anon, authenticated;
grant execute on function public.move_reader_library_to_trash(uuid, uuid) to service_role;
