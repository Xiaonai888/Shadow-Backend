create table if not exists public.resource_cost_daily_snapshots (
  snapshot_date date primary key,
  captured_at timestamptz not null default now(),
  status text not null check (status in ('complete', 'partial')),
  attempt_count smallint not null default 1 check (attempt_count between 1 and 2),
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);

alter table public.resource_cost_daily_snapshots enable row level security;

revoke all on table public.resource_cost_daily_snapshots from public, anon, authenticated;
grant select, insert, update on table public.resource_cost_daily_snapshots to service_role;
