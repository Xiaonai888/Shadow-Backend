create or replace function public.set_daily_checkin_reminder_with_limit(
  p_user_id uuid,
  p_enabled boolean,
  p_limit integer default 10000
)
returns table (
  enabled boolean,
  enabled_count bigint,
  limit_reached boolean,
  just_reached_limit boolean
)
language plpgsql
as $$
declare
  v_current boolean := false;
  v_count bigint := 0;
begin
  perform pg_advisory_xact_lock(hashtext('daily_checkin_reminder_limit'));

  select r.enabled
    into v_current
  from public.reader_daily_checkin_reminders r
  where r.user_id = p_user_id;

  v_current := coalesce(v_current, false);

  select count(*)
    into v_count
  from public.reader_daily_checkin_reminders r
  where r.enabled = true;

  if p_enabled then
    if v_current then
      return query
      select true, v_count, (v_count >= p_limit), false;
      return;
    end if;

    if v_count >= p_limit then
      return query
      select false, v_count, true, false;
      return;
    end if;

    insert into public.reader_daily_checkin_reminders (
      user_id,
      enabled,
      updated_at
    )
    values (
      p_user_id,
      true,
      now()
    )
    on conflict (user_id)
    do update set
      enabled = true,
      updated_at = excluded.updated_at;

    v_count := v_count + 1;

    return query
    select true, v_count, (v_count >= p_limit), (v_count = p_limit);
    return;
  end if;

  if v_current then
    update public.reader_daily_checkin_reminders
    set
      enabled = false,
      updated_at = now()
    where user_id = p_user_id;

    v_count := greatest(v_count - 1, 0);
  end if;

  return query
  select false, v_count, (v_count >= p_limit), false;
end;
$$;

revoke execute on function public.set_daily_checkin_reminder_with_limit(uuid, boolean, integer)
from public, anon, authenticated;

grant execute on function public.set_daily_checkin_reminder_with_limit(uuid, boolean, integer)
to service_role;
