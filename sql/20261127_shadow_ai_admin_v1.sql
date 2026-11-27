begin;

create table if not exists public.shadow_ai_settings_history (
  id uuid primary key default gen_random_uuid(),
  admin_id text not null check (char_length(admin_id) between 1 and 128),
  before_settings jsonb not null,
  after_settings jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists shadow_ai_settings_history_created_idx on public.shadow_ai_settings_history (created_at desc);
alter table public.shadow_ai_settings_history enable row level security;
revoke all on table public.shadow_ai_settings_history from public, anon, authenticated;
grant select, insert on table public.shadow_ai_settings_history to service_role;

create or replace function public.shadow_ai_admin_overview_v1(p_days integer)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare
  day_key date := (now() at time zone 'Asia/Phnom_Penh')::date;
  start_day date;
  result jsonb;
begin
  if p_days is null or p_days not in (1,7,30) then raise exception 'SHADOW_AI_INVALID_PERIOD'; end if;
  start_day := day_key - (p_days - 1);
  with scoped as (
    select usage_day, status, model, task, input_tokens, output_tokens, error_code
    from public.shadow_ai_requests where usage_day between start_day and day_key
  ), totals as (
    select count(*) as requests, count(*) filter (where status='ok') as successful,
      count(*) filter (where status='error') as errors, count(*) filter (where status='reserved') as reserved,
      coalesce(sum(input_tokens),0) as input_tokens, coalesce(sum(output_tokens),0) as output_tokens,
      count(*) filter (where input_tokens is null or output_tokens is null) as unknown_usage
    from scoped
  ), daily as (
    select usage_day, count(*) as requests, count(*) filter (where status='error') as errors
    from scoped group by usage_day
  ), models as (
    select model, count(*) as requests, coalesce(sum(input_tokens),0) as input_tokens,
      coalesce(sum(output_tokens),0) as output_tokens,
      count(*) filter (where input_tokens is null or output_tokens is null) as unknown_usage
    from scoped group by model order by count(*) desc, model limit 50
  ), errors as (
    select coalesce(error_code,'UNKNOWN') as code, count(*) as requests
    from scoped where status='error' group by 1 order by count(*) desc, 1 limit 20
  )
  select jsonb_build_object('from_day',start_day,'to_day',day_key,'totals',(select to_jsonb(t) from totals t),
    'daily',coalesce((select jsonb_agg(to_jsonb(d) order by d.usage_day) from daily d),'[]'::jsonb),
    'models',coalesce((select jsonb_agg(to_jsonb(m) order by m.requests desc,m.model) from models m),'[]'::jsonb),
    'errors',coalesce((select jsonb_agg(to_jsonb(e) order by e.requests desc,e.code) from errors e),'[]'::jsonb),
    'settings',(select to_jsonb(s) from public.shadow_ai_settings s where id=1),
    'history',coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc) from (
      select id, before_settings, after_settings, created_at from public.shadow_ai_settings_history order by created_at desc,id desc limit 20
    ) h),'[]'::jsonb)) into result;
  return result;
end;
$$;

create or replace function public.shadow_ai_admin_update_v1(p_admin_id text,p_expected_updated_at timestamptz,p_enabled boolean,p_preorder_enabled boolean,p_daily_request_limit integer,p_daily_user_limit integer)
returns jsonb language plpgsql set search_path = pg_catalog, public as $$
declare
  previous public.shadow_ai_settings%rowtype;
  updated public.shadow_ai_settings%rowtype;
begin
  if p_admin_id is null or char_length(p_admin_id) not between 1 and 128 or p_expected_updated_at is null
    or p_enabled is null or p_preorder_enabled is null or (p_preorder_enabled and not p_enabled)
    or p_daily_request_limit is null or p_daily_request_limit not between 1 and 10000
    or p_daily_user_limit is null or p_daily_user_limit not between 1 and 200 or p_daily_user_limit > p_daily_request_limit then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_SETTINGS_INVALID');
  end if;
  select * into previous from public.shadow_ai_settings where id=1 for update;
  if not found then return jsonb_build_object('ok',false,'code','SHADOW_AI_SETTINGS_UNAVAILABLE'); end if;
  if previous.updated_at is distinct from p_expected_updated_at then return jsonb_build_object('ok',false,'code','SHADOW_AI_SETTINGS_CONFLICT'); end if;
  if (previous.enabled,previous.preorder_enabled,previous.daily_request_limit,previous.daily_user_limit)
    is not distinct from (p_enabled,p_preorder_enabled,p_daily_request_limit,p_daily_user_limit) then
    return jsonb_build_object('ok',true,'settings',to_jsonb(previous));
  end if;
  update public.shadow_ai_settings set enabled=p_enabled,preorder_enabled=p_preorder_enabled,
    daily_request_limit=p_daily_request_limit,daily_user_limit=p_daily_user_limit,updated_at=clock_timestamp()
    where id=1 returning * into updated;
  insert into public.shadow_ai_settings_history(admin_id,before_settings,after_settings)
    values(p_admin_id,to_jsonb(previous),to_jsonb(updated));
  return jsonb_build_object('ok',true,'settings',to_jsonb(updated));
end;
$$;

revoke all on function public.shadow_ai_admin_overview_v1(integer) from public, anon, authenticated;
revoke all on function public.shadow_ai_admin_update_v1(text,timestamptz,boolean,boolean,integer,integer) from public, anon, authenticated;
grant execute on function public.shadow_ai_admin_overview_v1(integer) to service_role;
grant execute on function public.shadow_ai_admin_update_v1(text,timestamptz,boolean,boolean,integer,integer) to service_role;
commit;
