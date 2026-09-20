create or replace function public.clear_reader_library_trash_on_save()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.reader_library_trash
  where user_id = new.user_id and story_id = new.story_id;
  return new;
end;
$$;

drop trigger if exists reader_library_trash_on_save on public.reader_library;
create trigger reader_library_trash_on_save
after insert or update on public.reader_library
for each row execute function public.clear_reader_library_trash_on_save();

delete from public.reader_library_trash as trash
where exists (
  select 1 from public.reader_library as saved
  where saved.user_id = trash.user_id and saved.story_id = trash.story_id
);

revoke all on function public.clear_reader_library_trash_on_save() from public, anon, authenticated;
