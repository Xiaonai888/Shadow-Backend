create or replace function public.admin_manage_author_100_percent_event(
  p_author_id uuid,
  p_action text,
  p_admin_id text,
  p_admin_email text default '',
  p_duration_seconds bigint default 31536000,
  p_passkey_verified boolean default false
)
returns public.author_100_percent_event_cycles
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz;
  v_author_name text;
  v_cycle public.author_100_percent_event_cycles%rowtype;
  v_elapsed bigint;
  v_before bigint;
  v_after bigint;
  v_active_count integer;
  v_has_previous boolean;
  v_action text;
begin
  if p_author_id is null or nullif(btrim(p_admin_id), '') is null then
    raise exception 'Author ID and admin identity are required';
  end if;

  if p_action not in ('add', 'remove') or p_action is null then
    raise exception 'Invalid event action';
  end if;

  if p_action = 'add' and (p_duration_seconds is null or p_duration_seconds < 1 or p_duration_seconds > 315360000) then
    raise exception 'Invalid event duration';
  end if;

  if p_action = 'remove' and not coalesce(p_passkey_verified, false) then
    raise exception 'Passkey verification is required to remove an author';
  end if;

  perform pg_advisory_xact_lock(981735113::bigint);
  v_now := clock_timestamp();

  select a.page_name into v_author_name
  from public.author_pages a
  where a.id = p_author_id;

  if not found then
    raise exception 'Author ID not found';
  end if;

  select * into v_cycle
  from public.author_100_percent_event_cycles c
  where c.author_id = p_author_id and c.status <> 'completed'
  order by c.created_at desc, c.id desc
  limit 1
  for update;

  if found and v_cycle.status = 'active' then
    v_elapsed := greatest(0, floor(extract(epoch from (v_now - v_cycle.last_resumed_at)))::bigint);

    if v_elapsed >= v_cycle.remaining_seconds then
      v_before := v_cycle.remaining_seconds;

      update public.author_100_percent_event_cycles
      set used_seconds = duration_seconds,
          remaining_seconds = 0,
          status = 'completed',
          completed_at = last_resumed_at + remaining_seconds * interval '1 second',
          updated_at = v_now
      where id = v_cycle.id
      returning * into v_cycle;

      insert into public.author_100_percent_event_history (
        cycle_id, author_id, author_name_snapshot, admin_id, admin_email,
        action, status_before, status_after,
        seconds_remaining_before, seconds_remaining_after, passkey_verified
      ) values (
        v_cycle.id, p_author_id, v_author_name, p_admin_id, coalesce(p_admin_email, ''),
        'complete', 'active', 'completed', v_before, 0, coalesce(p_passkey_verified, false)
      );

      if p_action = 'remove' then
        return v_cycle;
      end if;

      v_cycle := null;
    end if;
  end if;

  if p_action = 'remove' then
    if v_cycle.id is null or v_cycle.status not in ('active', 'scheduled') then
      raise exception 'Author does not have a running or scheduled event';
    end if;

    v_before := v_cycle.remaining_seconds;
    v_elapsed := case
      when v_cycle.status = 'active' then
        least(v_before, greatest(0, floor(extract(epoch from (v_now - v_cycle.last_resumed_at)))::bigint))
      else 0
    end;
    v_after := v_before - v_elapsed;

    update public.author_100_percent_event_cycles
    set used_seconds = used_seconds + v_elapsed,
        remaining_seconds = v_after,
        status = 'paused',
        last_paused_at = v_now,
        updated_at = v_now
    where id = v_cycle.id
    returning * into v_cycle;

    insert into public.author_100_percent_event_history (
      cycle_id, author_id, author_name_snapshot, admin_id, admin_email,
      action, status_before, status_after,
      seconds_remaining_before, seconds_remaining_after, passkey_verified
    ) values (
      v_cycle.id, p_author_id, v_author_name, p_admin_id, coalesce(p_admin_email, ''),
      'remove', case when v_cycle.first_started_at is null then 'scheduled' else 'active' end,
      'paused', v_before, v_after, true
    );

    return v_cycle;
  end if;

  if v_cycle.id is not null and v_cycle.status <> 'paused' then
    raise exception 'Author already has an active or scheduled event';
  end if;

  select count(*) into v_active_count
  from public.author_100_percent_event_cycles c
  where c.status = 'active'
    and c.last_resumed_at + c.remaining_seconds * interval '1 second' > v_now;

  if v_active_count >= 10 and not coalesce(p_passkey_verified, false) then
    raise exception 'Passkey verification is required above the 10-author limit';
  end if;

  if v_cycle.id is not null then
    if v_cycle.remaining_seconds <= 0 then
      raise exception 'This event cycle has no remaining time';
    end if;

    v_before := v_cycle.remaining_seconds;

    update public.author_100_percent_event_cycles
    set status = 'active',
        first_started_at = coalesce(first_started_at, v_now),
        last_resumed_at = v_now,
        updated_at = v_now
    where id = v_cycle.id
    returning * into v_cycle;

    v_action := 'resume';
  else
    select exists (
      select 1 from public.author_100_percent_event_cycles c
      where c.author_id = p_author_id and c.status = 'completed'
    ) into v_has_previous;

    if v_has_previous and not coalesce(p_passkey_verified, false) then
      raise exception 'Passkey verification is required for a new event cycle';
    end if;

    insert into public.author_100_percent_event_cycles (
      author_id, author_name_at_grant, duration_seconds, remaining_seconds,
      used_seconds, status, first_started_at, last_resumed_at
    ) values (
      p_author_id, coalesce(v_author_name, ''), p_duration_seconds, p_duration_seconds,
      0, 'active', v_now, v_now
    ) returning * into v_cycle;

    v_before := null;
    v_action := case when v_has_previous then 'regrant' else 'add' end;
  end if;

  insert into public.author_100_percent_event_history (
    cycle_id, author_id, author_name_snapshot, admin_id, admin_email,
    action, status_before, status_after,
    seconds_remaining_before, seconds_remaining_after, passkey_verified
  ) values (
    v_cycle.id, p_author_id, v_author_name, p_admin_id, coalesce(p_admin_email, ''),
    v_action, case when v_action = 'resume' then 'paused' else null end,
    'active', v_before, v_cycle.remaining_seconds, coalesce(p_passkey_verified, false)
  );

  return v_cycle;
end;
$$;

revoke all on function public.admin_manage_author_100_percent_event(uuid, text, text, text, bigint, boolean) from public, anon, authenticated;
grant execute on function public.admin_manage_author_100_percent_event(uuid, text, text, text, bigint, boolean) to service_role;
