create table if not exists public.work_kill_switches (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  target_type text not null check (target_type in ('api', 'page')),
  source text not null check (source in ('WEB', 'ADMIN', 'BACKEND', 'ALL')),
  method text,
  path text not null check (path like '/%' and position('?' in path) = 0),
  enabled boolean not null default false,
  mode text not null default 'manual' check (mode in ('manual', 'automatic')),
  reason text,
  incident_id uuid references public.work_incidents(id) on delete set null,
  activated_at timestamptz,
  deactivated_at timestamptz,
  expires_at timestamptz,
  activation_count integer not null default 0 check (activation_count >= 0),
  blocked_requests bigint not null default 0 check (blocked_requests >= 0),
  last_triggered_at timestamptz,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (target_type = 'api' and method is not null and length(trim(method)) > 0)
    or
    (target_type = 'page' and method is null)
  ),
  check (method is null or method = upper(method))
);

create index if not exists work_kill_switches_enabled_idx
  on public.work_kill_switches (source, target_type, path)
  where enabled = true;

create index if not exists work_kill_switches_updated_idx
  on public.work_kill_switches (updated_at desc);

alter table public.work_kill_switches enable row level security;

create or replace function public.set_work_kill_switch(
  p_target_type text,
  p_source text,
  p_method text,
  p_path text,
  p_enabled boolean,
  p_mode text,
  p_reason text,
  p_incident_id uuid,
  p_expires_at timestamptz,
  p_actor text
)
returns public.work_kill_switches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_type text := lower(trim(coalesce(p_target_type, '')));
  v_source text := upper(trim(coalesce(p_source, '')));
  v_method text := nullif(upper(trim(coalesce(p_method, ''))), '');
  v_path text := trim(coalesce(p_path, ''));
  v_mode text := lower(trim(coalesce(p_mode, 'manual')));
  v_fingerprint text;
  v_record public.work_kill_switches;
begin
  if v_target_type not in ('api', 'page') then
    raise exception 'Invalid target_type';
  end if;

  if v_source not in ('WEB', 'ADMIN', 'BACKEND', 'ALL') then
    raise exception 'Invalid source';
  end if;

  if v_mode not in ('manual', 'automatic') then
    raise exception 'Invalid mode';
  end if;

  if v_path = '' or left(v_path, 1) <> '/' or position('?' in v_path) > 0 then
    raise exception 'Invalid path';
  end if;

  if v_target_type = 'api' and v_method is null then
    raise exception 'API target requires method';
  end if;

  if v_target_type = 'page' then
    v_method := null;
  end if;

  v_fingerprint :=
    v_target_type || '|' ||
    v_source || '|' ||
    coalesce(v_method, 'PAGE') || '|' ||
    v_path;

  insert into public.work_kill_switches (
    fingerprint,
    target_type,
    source,
    method,
    path,
    enabled,
    mode,
    reason,
    incident_id,
    activated_at,
    deactivated_at,
    expires_at,
    activation_count,
    created_by,
    updated_by,
    created_at,
    updated_at
  )
  values (
    v_fingerprint,
    v_target_type,
    v_source,
    v_method,
    v_path,
    p_enabled,
    v_mode,
    nullif(trim(coalesce(p_reason, '')), ''),
    p_incident_id,
    case when p_enabled then now() else null end,
    case when p_enabled then null else now() end,
    case when p_enabled then p_expires_at else null end,
    case when p_enabled then 1 else 0 end,
    nullif(trim(coalesce(p_actor, '')), ''),
    nullif(trim(coalesce(p_actor, '')), ''),
    now(),
    now()
  )
  on conflict (fingerprint) do update
  set
    enabled = excluded.enabled,
    mode = excluded.mode,
    reason = excluded.reason,
    incident_id = excluded.incident_id,
    activated_at = case
      when excluded.enabled and not public.work_kill_switches.enabled then now()
      else public.work_kill_switches.activated_at
    end,
    deactivated_at = case
      when not excluded.enabled and public.work_kill_switches.enabled then now()
      when excluded.enabled then null
      else public.work_kill_switches.deactivated_at
    end,
    expires_at = case
      when excluded.enabled then excluded.expires_at
      else null
    end,
    activation_count = public.work_kill_switches.activation_count +
      case
        when excluded.enabled and not public.work_kill_switches.enabled then 1
        else 0
      end,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into v_record;

  return v_record;
end;
$$;

create or replace function public.record_work_kill_switch_usage(
  p_id uuid,
  p_blocked_delta bigint,
  p_last_triggered_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(p_blocked_delta, 0) <= 0 then
    return;
  end if;

  update public.work_kill_switches
  set
    blocked_requests = blocked_requests + p_blocked_delta,
    last_triggered_at = greatest(
      coalesce(last_triggered_at, '-infinity'::timestamptz),
      coalesce(p_last_triggered_at, now())
    ),
    updated_at = now()
  where id = p_id;
end;
$$;

revoke all on function public.set_work_kill_switch(
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  uuid,
  timestamptz,
  text
) from public;

revoke all on function public.record_work_kill_switch_usage(
  uuid,
  bigint,
  timestamptz
) from public;

grant execute on function public.set_work_kill_switch(
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  uuid,
  timestamptz,
  text
) to service_role;

grant execute on function public.record_work_kill_switch_usage(
  uuid,
  bigint,
  timestamptz
) to service_role;
