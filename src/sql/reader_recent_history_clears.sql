begin;

create table if not exists public.reader_recent_history_clears (
  user_id uuid primary key references public.users(id) on delete cascade,
  cleared_at timestamptz not null default clock_timestamp()
);

alter table public.reader_recent_history_clears enable row level security;
revoke all on public.reader_recent_history_clears from public, anon, authenticated;
grant select, insert, update on public.reader_recent_history_clears to service_role;

create or replace function public.clear_reader_recent_history(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cleared_at timestamptz := clock_timestamp();
begin
  if p_user_id is null then
    raise exception 'Reader account required' using errcode = '22023';
  end if;

  insert into public.reader_recent_history_clears (user_id, cleared_at)
  values (p_user_id, v_cleared_at)
  on conflict (user_id) do update
    set cleared_at = excluded.cleared_at;

  return v_cleared_at;
end;
$$;

revoke all on function public.clear_reader_recent_history(uuid) from public, anon, authenticated;
grant execute on function public.clear_reader_recent_history(uuid) to service_role;

commit;
