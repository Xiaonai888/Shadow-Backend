begin;
create table if not exists public.shadow_ai_gemini_daily_learning_lock (
  id smallint primary key check (id = 1),
  claimed_day date not null,
  claimed_at timestamptz not null
);
alter table public.shadow_ai_gemini_daily_learning_lock enable row level security;
revoke all on public.shadow_ai_gemini_daily_learning_lock from public, anon, authenticated, service_role;

create or replace function public.shadow_ai_gemini_claim_learning_day_v1(p_day date)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_local timestamp := v_now at time zone 'Asia/Phnom_Penh';
begin
  if p_day is null or p_day <> v_local::date or extract(hour from v_local) <> 2 then
    return false;
  end if;
  insert into public.shadow_ai_gemini_daily_learning_lock as previous (id, claimed_day, claimed_at)
  values (1, p_day, v_now)
  on conflict (id) do update
    set claimed_day = excluded.claimed_day, claimed_at = excluded.claimed_at
    where previous.claimed_day < excluded.claimed_day;
  return found;
end;
$$;
revoke all on function public.shadow_ai_gemini_claim_learning_day_v1(date) from public, anon, authenticated, service_role;
grant execute on function public.shadow_ai_gemini_claim_learning_day_v1(date) to service_role;
commit;
