begin;
alter table public.shadow_ai_gemini_quota drop constraint if exists shadow_ai_gemini_quota_day_count_check;
alter table public.shadow_ai_gemini_quota add constraint shadow_ai_gemini_quota_day_count_check check (day_count between 0 and 500);
create or replace function public.shadow_ai_gemini_reserve_v1(p_daily_limit integer)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  r public.shadow_ai_gemini_quota%rowtype;
  v_now timestamptz;
  v_day date;
  v_day_count integer;
  v_minute_count integer;
  v_minute_start timestamptz;
begin
  if p_daily_limit is null or p_daily_limit not between 1 and 500 then return false; end if;
  select * into r from public.shadow_ai_gemini_quota where id=1 for update;
  if not found then return false; end if;
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'America/Los_Angeles')::date;
  if v_day < r.quota_day or v_now < r.minute_started_at then return false; end if;
  v_day_count := case when v_day = r.quota_day then r.day_count else 0 end;
  v_minute_start := case when v_now >= r.minute_started_at + interval '60 seconds' then v_now else r.minute_started_at end;
  v_minute_count := case when v_minute_start = r.minute_started_at then r.minute_count else 0 end;
  if v_day_count >= p_daily_limit or v_minute_count >= 5 then return false; end if;
  update public.shadow_ai_gemini_quota set quota_day=v_day,day_count=v_day_count+1,minute_started_at=v_minute_start,minute_count=v_minute_count+1 where id=1;
  return true;
end;
$$;
revoke all on function public.shadow_ai_gemini_reserve_v1(integer) from public,anon,authenticated,service_role;
grant execute on function public.shadow_ai_gemini_reserve_v1(integer) to service_role;
commit;
