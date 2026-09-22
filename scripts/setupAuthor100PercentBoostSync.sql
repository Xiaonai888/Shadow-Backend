create or replace function public.sync_author_100_percent_event_boost()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_was_active boolean := false;
  v_event_ended_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    v_was_active := old.status = 'active';
  end if;

  if new.status = 'active' and not v_was_active then
    update public.author_lifetime_boosts as b
    set admin_event_paused_at = new.last_resumed_at,
        admin_event_remaining_seconds = greatest(
          0,
          ceil(extract(epoch from (b.ended_at - new.last_resumed_at)))::bigint
        ),
        admin_event_pause_cycle_id = new.id,
        updated_at = clock_timestamp()
    where b.author_id = new.author_id
      and b.boost_type = '100_percent_100_days'
      and b.status = 'active'
      and b.admin_event_pause_cycle_id is null
      and b.ended_at > new.last_resumed_at;
  elsif v_was_active and new.status in ('paused', 'completed') then
    v_event_ended_at := case
      when new.status = 'completed' then new.completed_at
      else new.last_paused_at
    end;

    update public.author_lifetime_boosts as b
    set ended_at = coalesce(v_event_ended_at, clock_timestamp())
          + b.admin_event_remaining_seconds * interval '1 second',
        admin_event_paused_at = null,
        admin_event_remaining_seconds = null,
        admin_event_pause_cycle_id = null,
        updated_at = clock_timestamp()
    where b.author_id = new.author_id
      and b.boost_type = '100_percent_100_days'
      and b.admin_event_pause_cycle_id = new.id
      and b.admin_event_remaining_seconds is not null;
  end if;

  return new;
end;
$$;

drop trigger if exists sync_author_100_percent_event_boost_trigger
  on public.author_100_percent_event_cycles;

create trigger sync_author_100_percent_event_boost_trigger
after insert or update of status
on public.author_100_percent_event_cycles
for each row
execute function public.sync_author_100_percent_event_boost();

revoke all on function public.sync_author_100_percent_event_boost()
  from public, anon, authenticated;
