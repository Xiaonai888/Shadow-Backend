create table if not exists public.reader_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  device_key_hash text not null,
  device_label text not null default 'Unknown device',
  browser_name text,
  os_name text,
  last_ip text,
  last_user_agent text,
  first_login_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, device_key_hash),
  unique (user_id, id),
  constraint reader_devices_key_hash_check check (device_key_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.reader_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  device_id uuid not null,
  jwt_id uuid not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '60 days'),
  revoked_at timestamptz,
  revoked_reason text,
  constraint reader_sessions_device_owner_fk
    foreign key (user_id, device_id)
    references public.reader_devices(user_id, id) on delete cascade,
  constraint reader_sessions_valid_expiry_check check (expires_at > created_at)
);

create index if not exists reader_devices_user_seen_idx
  on public.reader_devices (user_id, last_seen_at desc);

create index if not exists reader_sessions_user_seen_idx
  on public.reader_sessions (user_id, last_seen_at desc)
  where revoked_at is null;

create index if not exists reader_sessions_device_expiry_idx
  on public.reader_sessions (device_id, expires_at desc)
  where revoked_at is null;

alter table public.reader_devices enable row level security;
alter table public.reader_sessions enable row level security;

revoke all on table public.reader_devices from public, anon, authenticated;
revoke all on table public.reader_sessions from public, anon, authenticated;

grant all on table public.reader_devices to service_role;
grant all on table public.reader_sessions to service_role;
