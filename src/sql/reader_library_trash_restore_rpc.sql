create or replace function public.restore_reader_library_from_trash(
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
begin
  if p_user_id is null or p_story_id is null then
    return false;
  end if;

  if not exists (
    select 1 from public.stories
    where id = p_story_id
      and status = 'published'
      and deleted_at is null
  ) then
    return false;
  end if;

  delete from public.reader_library_trash
  where user_id = p_user_id
    and story_id = p_story_id
    and expires_at > clock_timestamp()
  returning originally_saved_at into v_saved_at;

  if not found then
    return false;
  end if;

  insert into public.reader_library (user_id, story_id, created_at)
  values (p_user_id, p_story_id, coalesce(v_saved_at, clock_timestamp()))
  on conflict (user_id, story_id) do nothing;

  return true;
end;
$$;

revoke all on function public.restore_reader_library_from_trash(uuid, uuid) from public, anon, authenticated;
grant execute on function public.restore_reader_library_from_trash(uuid, uuid) to service_role;
