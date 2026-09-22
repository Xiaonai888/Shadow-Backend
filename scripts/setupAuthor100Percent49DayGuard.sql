create or replace function public.guard_author_49_day_during_admin_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from 'active' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'active' then
      return new;
    end if;
  end if;

  if exists (
    select 1
    from public.author_100_percent_event_cycles as c
    where c.author_id = new.author_id
      and c.status = 'active'
      and c.last_resumed_at + c.remaining_seconds * interval '1 second' > statement_timestamp()
  ) then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_author_49_day_during_admin_event_trigger
  on public.author_49_day_event_progress;

create trigger guard_author_49_day_during_admin_event_trigger
before insert or update of status on public.author_49_day_event_progress
for each row
execute function public.guard_author_49_day_during_admin_event();

revoke all on function public.guard_author_49_day_during_admin_event()
  from public, anon, authenticated;
