create or replace function public.reader_register_device_session(
  p_user_id uuid,
  p_device_key_hash text,
  p_device_label text,
  p_browser_name text,
  p_os_name text,
  p_last_ip text,
  p_last_user_agent text,
  p_jwt_id uuid
)
returns table (device_id uuid, session_id uuid, expires_at timestamptz)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_device_id uuid;
  v_session_id uuid;
  v_expiry timestamptz;
  v_active_count integer;
  v_same_device_active boolean;
begin
  if p_user_id is null or p_jwt_id is null or p_device_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_READER_DEVICE_SESSION_REQUEST';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select count(*) into v_active_count
  from public.reader_sessions s
  where s.user_id = p_user_id and s.revoked_at is null and s.expires_at > v_now;

  select exists (
    select 1
    from public.reader_sessions s
    join public.reader_devices d on d.id = s.device_id and d.user_id = s.user_id
    where s.user_id = p_user_id
      and d.device_key_hash = p_device_key_hash
      and s.revoked_at is null and s.expires_at > v_now
  ) into v_same_device_active;

  if v_active_count >= 5 and not v_same_device_active then
    raise exception 'READER_SESSION_LIMIT_REACHED';
  end if;

  insert into public.reader_devices (
    user_id, device_key_hash, device_label, browser_name, os_name,
    last_ip, last_user_agent, last_login_at, last_seen_at
  ) values (
    p_user_id, p_device_key_hash, p_device_label, p_browser_name, p_os_name,
    p_last_ip, p_last_user_agent, v_now, v_now
  )
  on conflict (user_id, device_key_hash) do update set
    device_label = excluded.device_label,
    browser_name = excluded.browser_name,
    os_name = excluded.os_name,
    last_ip = excluded.last_ip,
    last_user_agent = excluded.last_user_agent,
    last_login_at = excluded.last_login_at,
    last_seen_at = excluded.last_seen_at
  returning id into v_device_id;

  update public.reader_sessions s
  set revoked_at = v_now, revoked_reason = 'Replaced by a new login on the same device'
  where s.user_id = p_user_id and s.device_id = v_device_id
    and s.revoked_at is null and s.expires_at > v_now;

  v_expiry := v_now + interval '60 days';

  insert into public.reader_sessions (
    user_id, device_id, jwt_id, created_at, last_seen_at, expires_at
  ) values (
    p_user_id, v_device_id, p_jwt_id, v_now, v_now, v_expiry
  ) returning id into v_session_id;

  return query select v_device_id, v_session_id, v_expiry;
end;
$$;

revoke all on function public.reader_register_device_session(uuid, text, text, text, text, text, text, uuid)
from public, anon, authenticated;

grant execute on function public.reader_register_device_session(uuid, text, text, text, text, text, text, uuid)
to service_role;
