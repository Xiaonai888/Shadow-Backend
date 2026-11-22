create table if not exists public.manga_device_part_sessions (
  id uuid primary key,
  user_id uuid not null,
  manifest jsonb not null,
  status text not null default 'pending',
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  processing_token uuid,
  completed_at timestamptz,
  constraint manga_device_part_sessions_status_check
    check (status in ('pending', 'processing', 'completed')),
  constraint manga_device_part_sessions_manifest_check
    check (jsonb_typeof(manifest) = 'object')
);

create index if not exists manga_device_part_sessions_user_created_idx
  on public.manga_device_part_sessions (user_id, created_at desc);

create index if not exists manga_device_part_sessions_status_expires_idx
  on public.manga_device_part_sessions (status, expires_at);

alter table public.manga_device_part_sessions enable row level security;

revoke all on public.manga_device_part_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.manga_device_part_sessions to service_role;

create or replace function public.claim_manga_device_part_session(
  p_session_id uuid,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
  v_claimed uuid;
begin
  update public.manga_device_part_sessions
  set status = 'processing',
      processing_token = v_token,
      claimed_at = now()
  where id = p_session_id
    and user_id = p_user_id
    and expires_at > now()
    and (
      status = 'pending'
      or (status = 'processing' and claimed_at < now() - interval '5 minutes')
    )
  returning processing_token into v_claimed;

  return v_claimed;
end;
$$;

revoke all on function public.claim_manga_device_part_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_manga_device_part_session(uuid, uuid) to service_role;
