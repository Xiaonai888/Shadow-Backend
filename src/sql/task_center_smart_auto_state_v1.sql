begin;

create table if not exists public.task_center_smart_auto_state (
  reader_id text primary key check (length(reader_id) between 1 and 128),
  revision integer not null check (revision > 0),
  day_start_ms bigint not null,
  missions jsonb not null check (jsonb_typeof(missions) = 'array' and jsonb_array_length(missions) <= 2),
  daily_assigned_ids jsonb not null check (jsonb_typeof(daily_assigned_ids) = 'array' and jsonb_array_length(daily_assigned_ids) <= 8),
  updated_at timestamptz not null default now()
);

alter table public.task_center_smart_auto_state enable row level security;
revoke all on public.task_center_smart_auto_state from public, anon, authenticated, service_role;
grant select on public.task_center_smart_auto_state to service_role;

create or replace function public.task_center_smart_auto_save_v1(
  p_reader_id text,
  p_expected_revision integer,
  p_day_start_ms bigint,
  p_missions jsonb,
  p_daily_assigned_ids jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid expected revision';
  end if;
  if p_expected_revision = 0 then
    insert into public.task_center_smart_auto_state
      (reader_id, revision, day_start_ms, missions, daily_assigned_ids)
    values (p_reader_id, 1, p_day_start_ms, p_missions, p_daily_assigned_ids)
    on conflict (reader_id) do nothing;
  else
    update public.task_center_smart_auto_state
    set revision = revision + 1,
        day_start_ms = p_day_start_ms,
        missions = p_missions,
        daily_assigned_ids = p_daily_assigned_ids,
        updated_at = now()
    where reader_id = p_reader_id and revision = p_expected_revision;
  end if;
  return found;
end;
$$;

revoke all on function public.task_center_smart_auto_save_v1(text, integer, bigint, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.task_center_smart_auto_save_v1(text, integer, bigint, jsonb, jsonb) to service_role;

commit;
