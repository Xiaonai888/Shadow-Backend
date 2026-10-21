begin;

create or replace function public.capture_reader_activity_echo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  activity_time timestamptz;
  activity_key text;
begin
  if tg_op = 'UPDATE' and coalesce(new.share_count, 0) <= coalesce(old.share_count, 0) then
    return new;
  end if;

  if new.user_id is null or new.id is null then
    return new;
  end if;

  activity_time := coalesce(new.updated_at, new.created_at, clock_timestamp());
  activity_key := 'echo:' || new.id::text || ':' || greatest(1, coalesce(new.share_count, 1))::text;

  begin
    insert into public.reader_activity_events (
      user_id, category, action, subject_type, subject_id, event_key, occurred_at
    ) values (
      new.user_id, 'interactions', 'echo',
      left(coalesce(new.source_type::text, 'echo'), 40),
      left(coalesce(new.source_id::text, new.id::text), 128),
      left(activity_key, 160), activity_time
    ) on conflict do nothing;
  exception when others then
    raise warning 'READER_ACTIVITY_ECHO_CAPTURE_FAILED: %', sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.capture_reader_activity_echo() from public, anon, authenticated;
grant execute on function public.capture_reader_activity_echo() to service_role;

drop trigger if exists reader_activity_echo_capture_trigger on public.social_echoes_v2;
create trigger reader_activity_echo_capture_trigger
after insert or update of share_count on public.social_echoes_v2
for each row execute function public.capture_reader_activity_echo();

commit;
