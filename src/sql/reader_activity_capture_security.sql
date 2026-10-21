begin;

create or replace function public.record_reader_security_history(
  p_user_id uuid,
  p_action text,
  p_subject_type text,
  p_subject_id text,
  p_event_key text,
  p_occurred_at timestamptz,
  p_description text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_action is null or p_event_key is null then
    return;
  end if;

  insert into public.reader_activity_events (
    user_id, category, action, subject_type, subject_id,
    event_key, occurred_at, description
  ) values (
    p_user_id, 'security', left(p_action, 64),
    left(p_subject_type, 40), left(p_subject_id, 128),
    left(p_event_key, 160), coalesce(p_occurred_at, clock_timestamp()),
    left(p_description, 280)
  ) on conflict do nothing;
exception when others then
  raise warning 'READER_SECURITY_HISTORY_CAPTURE_FAILED: %', sqlerrm;
end;
$$;

create or replace function public.capture_reader_security_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'reader_sessions' then
    if tg_op = 'INSERT' then
      perform public.record_reader_security_history(
        new.user_id, 'login', 'device', new.device_id::text,
        'reader-login:' || new.id::text, new.created_at
      );
    elsif old.revoked_at is null and new.revoked_at is not null then
      perform public.record_reader_security_history(
        new.user_id, 'other', 'device', new.device_id::text,
        'reader-session-revoked:' || new.id::text, new.revoked_at,
        'Signed out of a device'
      );
    end if;

  elsif tg_table_name = 'users' and tg_op = 'UPDATE' then
    if old.password_hash is distinct from new.password_hash then
      perform public.record_reader_security_history(
        new.id, 'change_password', 'account', new.id::text,
        'reader-password-change:' || new.id::text || ':' || txid_current()::text,
        clock_timestamp()
      );
    end if;
    if old.email is distinct from new.email then
      perform public.record_reader_security_history(
        new.id, 'change_email', 'account', new.id::text,
        'reader-email-change:' || new.id::text || ':' || txid_current()::text,
        clock_timestamp()
      );
    end if;

  elsif tg_table_name = 'reader_security_settings' then
    if tg_op = 'INSERT' then
      if coalesce(new.email_2fa_enabled, false) then
        perform public.record_reader_security_history(
          new.user_id, 'other', 'account', new.user_id::text,
          'reader-2fa-enabled:' || new.user_id::text || ':' || txid_current()::text,
          clock_timestamp(), 'Email verification enabled'
        );
      end if;
      if new.pin_hash is not null then
        perform public.record_reader_security_history(
          new.user_id, 'other', 'account', new.user_id::text,
          'reader-pin-enabled:' || new.user_id::text || ':' || txid_current()::text,
          clock_timestamp(), 'Security PIN enabled'
        );
      end if;
    else
      if old.email_2fa_enabled is distinct from new.email_2fa_enabled then
        perform public.record_reader_security_history(
          new.user_id,
          case when new.email_2fa_enabled then 'other' else 'security_alert' end,
          'account', new.user_id::text,
          'reader-2fa-change:' || new.user_id::text || ':' || txid_current()::text,
          clock_timestamp(),
          case when new.email_2fa_enabled then 'Email verification enabled' else 'Email verification disabled' end
        );
      end if;
      if old.pin_hash is distinct from new.pin_hash then
        perform public.record_reader_security_history(
          new.user_id,
          case when new.pin_hash is null then 'security_alert' else 'other' end,
          'account', new.user_id::text,
          'reader-pin-change:' || new.user_id::text || ':' || txid_current()::text,
          clock_timestamp(),
          case when new.pin_hash is null then 'Security PIN disabled' when old.pin_hash is null then 'Security PIN enabled' else 'Security PIN changed' end
        );
      end if;
      if new.pin_locked_until is distinct from old.pin_locked_until
        and new.pin_locked_until is not null
        and new.pin_locked_until > clock_timestamp() then
        perform public.record_reader_security_history(
          new.user_id, 'login_alert', 'account', new.user_id::text,
          'reader-pin-locked:' || new.user_id::text || ':' || txid_current()::text,
          clock_timestamp(), 'Security PIN locked after failed attempts'
        );
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.record_reader_security_history(uuid, text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.capture_reader_security_activity() from public, anon, authenticated;
grant execute on function public.record_reader_security_history(uuid, text, text, text, text, timestamptz, text) to service_role;
grant execute on function public.capture_reader_security_activity() to service_role;

drop trigger if exists reader_activity_session_created_trigger on public.reader_sessions;
create trigger reader_activity_session_created_trigger
after insert on public.reader_sessions
for each row execute function public.capture_reader_security_activity();

drop trigger if exists reader_activity_session_revoked_trigger on public.reader_sessions;
create trigger reader_activity_session_revoked_trigger
after update of revoked_at on public.reader_sessions
for each row execute function public.capture_reader_security_activity();

drop trigger if exists reader_activity_credentials_trigger on public.users;
create trigger reader_activity_credentials_trigger
after update of password_hash, email on public.users
for each row execute function public.capture_reader_security_activity();

drop trigger if exists reader_activity_security_settings_trigger on public.reader_security_settings;
create trigger reader_activity_security_settings_trigger
after insert or update of email_2fa_enabled, pin_hash, pin_locked_until on public.reader_security_settings
for each row execute function public.capture_reader_security_activity();

commit;
