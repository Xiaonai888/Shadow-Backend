create or replace function public.guard_author_100_percent_creator_boost()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle_id uuid;
  v_resumed_at timestamptz;
begin
  if new.boost_type is distinct from '100_percent_100_days' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.admin_event_pause_cycle_id is not null then
      if new.admin_event_pause_cycle_id is not null then
        new.status := old.status;
        new.started_at := old.started_at;
        new.ended_at := old.ended_at;
        new.used_at := old.used_at;
        new.admin_event_paused_at := old.admin_event_paused_at;
        new.admin_event_remaining_seconds := old.admin_event_remaining_seconds;
        new.admin_event_pause_cycle_id := old.admin_event_pause_cycle_id;
      end if;
      return new;
    end if;
  end if;

  select c.id, c.last_resumed_at
  into v_cycle_id, v_resumed_at
  from public.author_100_percent_event_cycles as c
  where c.author_id = new.author_id
    and c.status = 'active'
    and c.last_resumed_at + c.remaining_seconds * interval '1 second' > statement_timestamp()
  order by c.created_at desc, c.id desc
  limit 1;

  if v_cycle_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'active' then
      new.status := 'eligible';
      new.eligible_at := null;
      new.started_at := null;
      new.ended_at := null;
      new.used_at := null;
    end if;
    return new;
  end if;

  if old.status in ('locked', 'eligible') and new.status = 'active' then
    new.status := 'eligible';
    new.eligible_at := null;
    new.started_at := null;
    new.ended_at := null;
    new.used_at := null;
  elsif old.status = 'active'
    and new.status = 'expired'
    and old.ended_at > v_resumed_at then
    new.status := 'active';
    new.started_at := old.started_at;
    new.ended_at := old.ended_at;
    new.used_at := old.used_at;
    new.admin_event_paused_at := v_resumed_at;
    new.admin_event_remaining_seconds := greatest(
      0,
      ceil(extract(epoch from (old.ended_at - v_resumed_at)))::bigint
    );
    new.admin_event_pause_cycle_id := v_cycle_id;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_author_100_percent_creator_boost_trigger
  on public.author_lifetime_boosts;

create trigger guard_author_100_percent_creator_boost_trigger
before insert or update
on public.author_lifetime_boosts
for each row
execute function public.guard_author_100_percent_creator_boost();

revoke all on function public.guard_author_100_percent_creator_boost()
  from public, anon, authenticated;
