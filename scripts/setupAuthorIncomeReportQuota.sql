create table if not exists public.author_income_report_quota (
  user_id uuid primary key,
  request_times timestamptz[] not null default '{}'::timestamptz[],
  updated_at timestamptz not null default now()
);

alter table public.author_income_report_quota enable row level security;
revoke all on public.author_income_report_quota from anon, authenticated;
grant select, insert, update on public.author_income_report_quota to service_role;

create or replace function public.get_author_income_report_export_guarded_v1(
  p_user_id uuid,
  p_period text default 'month',
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_requests timestamptz[];
  v_retry_seconds integer;
begin
  if p_user_id is null then
    raise exception 'Unauthorized';
  end if;

  insert into public.author_income_report_quota (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select q.request_times into v_requests
  from public.author_income_report_quota q
  where q.user_id = p_user_id
  for update;

  select coalesce(array_agg(item.ts order by item.ts), '{}'::timestamptz[])
  into v_requests
  from unnest(v_requests) as item(ts)
  where item.ts > now() - interval '1 hour';

  if cardinality(v_requests) >= 10 then
    select greatest(1, ceil(extract(epoch from (min(item.ts) + interval '1 hour' - now())))::integer)
    into v_retry_seconds
    from unnest(v_requests) as item(ts);
    raise exception 'REPORT_LIMIT_REACHED:%', v_retry_seconds;
  end if;

  update public.author_income_report_quota
  set request_times = array_append(v_requests, now()), updated_at = now()
  where user_id = p_user_id;

  return public.get_author_income_report_export_data_v1(
    p_user_id,
    p_period,
    p_from,
    p_to
  );
end;
$function$;

revoke all on function public.get_author_income_report_export_guarded_v1(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.get_author_income_report_export_guarded_v1(uuid, text, date, date) to service_role;

select
  to_regprocedure('public.get_author_income_report_export_data_v1(uuid,text,date,date)') is not null as export_function_ready,
  to_regprocedure('public.get_author_income_report_export_guarded_v1(uuid,text,date,date)') is not null as protected_export_ready;
