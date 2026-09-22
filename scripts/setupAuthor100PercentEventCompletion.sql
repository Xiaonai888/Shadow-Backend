create or replace function public.complete_expired_author_100_percent_event(p_author_id uuid)
returns public.author_100_percent_event_cycles
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_cycle public.author_100_percent_event_cycles%rowtype;
  v_completed_at timestamptz;
  v_author_name text;
  v_remaining_before bigint;
begin
  if p_author_id is null then
    raise exception 'Author ID is required';
  end if;

  perform pg_advisory_xact_lock(981735113::bigint);

  select * into v_cycle
  from public.author_100_percent_event_cycles
  where author_id = p_author_id
    and status = 'active'
    and last_resumed_at + remaining_seconds * interval '1 second' <= clock_timestamp()
  order by created_at desc, id desc
  limit 1
  for update;

  if not found then
    return null;
  end if;

  v_remaining_before := v_cycle.remaining_seconds;
  v_completed_at := v_cycle.last_resumed_at + v_cycle.remaining_seconds * interval '1 second';

  update public.author_100_percent_event_cycles
  set status = 'completed',
      used_seconds = duration_seconds,
      remaining_seconds = 0,
      completed_at = v_completed_at,
      updated_at = clock_timestamp()
  where id = v_cycle.id
  returning * into v_cycle;

  select page_name into v_author_name
  from public.author_pages
  where id = v_cycle.author_id;

  insert into public.author_100_percent_event_history (
    cycle_id, author_id, author_name_snapshot, admin_id, admin_email,
    action, status_before, status_after,
    seconds_remaining_before, seconds_remaining_after, passkey_verified
  ) values (
    v_cycle.id, v_cycle.author_id, coalesce(v_author_name, v_cycle.author_name_at_grant),
    'system', '', 'complete', 'active', 'completed',
    v_remaining_before, 0, false
  );

  return v_cycle;
end;
$$;

revoke all on function public.complete_expired_author_100_percent_event(uuid)
  from public, anon, authenticated;
grant execute on function public.complete_expired_author_100_percent_event(uuid)
  to service_role;
