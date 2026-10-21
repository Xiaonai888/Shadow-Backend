begin;

create or replace function public.capture_reader_activity_gift()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reader_id is null or new.source_key is null or new.story_id is null then
    return new;
  end if;

  begin
    insert into public.reader_activity_events (
      user_id, category, action, subject_type, subject_id, event_key, occurred_at
    ) values (
      new.reader_id, 'transactions', 'gift', 'story',
      left(new.story_id::text, 128),
      left('reader-gift:' || new.source_key::text, 160),
      coalesce(new.created_at, clock_timestamp())
    ) on conflict do nothing;
  exception when others then
    raise warning 'READER_ACTIVITY_GIFT_CAPTURE_FAILED: %', sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.capture_reader_activity_gift() from public, anon, authenticated;
grant execute on function public.capture_reader_activity_gift() to service_role;

drop trigger if exists reader_activity_gift_capture_trigger on public.author_gift_ledger;
create trigger reader_activity_gift_capture_trigger
after insert on public.author_gift_ledger
for each row execute function public.capture_reader_activity_gift();

commit;
