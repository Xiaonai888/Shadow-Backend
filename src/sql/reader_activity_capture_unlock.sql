begin;

create or replace function public.capture_reader_activity_unlock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is null or new.episode_id is null or new.id is null then
    return new;
  end if;

  if new.transaction_type is distinct from 'unlock' or coalesce(new.amount, 0) <= 0 then
    return new;
  end if;

  begin
    insert into public.reader_activity_events (
      user_id, category, action, subject_type, subject_id, event_key, occurred_at
    ) values (
      new.user_id, 'transactions', 'unlock', 'episode',
      left(new.episode_id::text, 128),
      left('unlock-transaction:' || new.id::text, 160),
      coalesce(new.created_at, clock_timestamp())
    ) on conflict do nothing;
  exception when others then
    raise warning 'READER_ACTIVITY_UNLOCK_CAPTURE_FAILED: %', sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.capture_reader_activity_unlock() from public, anon, authenticated;
grant execute on function public.capture_reader_activity_unlock() to service_role;

drop trigger if exists reader_activity_unlock_capture_trigger on public.episode_unlock_transactions;
create trigger reader_activity_unlock_capture_trigger
after insert on public.episode_unlock_transactions
for each row execute function public.capture_reader_activity_unlock();

commit;
