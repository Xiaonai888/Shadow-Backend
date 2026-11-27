begin;

create table if not exists public.shadow_ai_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  preorder_enabled boolean not null default false,
  daily_request_limit integer not null default 300 check (daily_request_limit between 1 and 10000),
  daily_user_limit integer not null default 20 check (daily_user_limit between 1 and 200),
  updated_at timestamptz not null default now()
);

insert into public.shadow_ai_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.shadow_ai_requests (
  id uuid primary key,
  actor_user_id uuid not null,
  role text not null check (role = 'preorder'),
  task text not null check (task in ('reader_message', 'author_requirements')),
  model text not null check (char_length(model) between 1 and 120),
  usage_day date not null,
  status text not null default 'reserved' check (status in ('reserved', 'ok', 'error')),
  input_tokens integer check (input_tokens between 0 and 1000000),
  output_tokens integer check (output_tokens between 0 and 1000000),
  error_code text check (error_code is null or error_code ~ '^SHADOW_AI_[A-Z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((status = 'reserved' and finished_at is null) or (status <> 'reserved' and finished_at is not null))
);

create index if not exists shadow_ai_requests_day_idx on public.shadow_ai_requests (usage_day);
create index if not exists shadow_ai_requests_actor_day_idx on public.shadow_ai_requests (actor_user_id, usage_day);

alter table public.shadow_ai_settings enable row level security;
alter table public.shadow_ai_requests enable row level security;
revoke all on table public.shadow_ai_settings, public.shadow_ai_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.shadow_ai_settings, public.shadow_ai_requests to service_role;

create or replace function public.shadow_ai_reserve_request_v1(
  p_request_id uuid, p_actor_user_id uuid, p_role text, p_task text, p_model text
) returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  cfg public.shadow_ai_settings%rowtype;
  day_key date;
  daily_count bigint;
  actor_count bigint;
begin
  if p_request_id is null or p_actor_user_id is null or p_role is distinct from 'preorder'
    or p_task is null or p_task not in ('reader_message', 'author_requirements')
    or p_model is null or char_length(p_model) not between 1 and 120 then
    return jsonb_build_object('ok', false, 'code', 'SHADOW_AI_INVALID_REQUEST');
  end if;
  select * into cfg from public.shadow_ai_settings where id = 1 for update;
  if not found or not cfg.enabled or not cfg.preorder_enabled then
    return jsonb_build_object('ok', false, 'code', 'SHADOW_AI_DISABLED');
  end if;
  day_key := (clock_timestamp() at time zone 'Asia/Phnom_Penh')::date;
  select count(*) into daily_count from public.shadow_ai_requests where usage_day = day_key;
  if daily_count >= cfg.daily_request_limit then
    return jsonb_build_object('ok', false, 'code', 'SHADOW_AI_DAILY_LIMIT');
  end if;
  select count(*) into actor_count from public.shadow_ai_requests
    where usage_day = day_key and actor_user_id = p_actor_user_id;
  if actor_count >= cfg.daily_user_limit then
    return jsonb_build_object('ok', false, 'code', 'SHADOW_AI_USER_LIMIT');
  end if;
  insert into public.shadow_ai_requests (id, actor_user_id, role, task, model, usage_day)
    values (p_request_id, p_actor_user_id, p_role, p_task, p_model, day_key)
    on conflict (id) do nothing;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SHADOW_AI_DUPLICATE_REQUEST');
  end if;
  return jsonb_build_object('ok', true, 'request_id', p_request_id);
end;
$$;

create or replace function public.shadow_ai_finish_request_v1(
  p_request_id uuid, p_status text, p_input_tokens integer, p_output_tokens integer, p_error_code text
) returns boolean
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if p_status is null or p_status not in ('ok', 'error') then return false; end if;
  update public.shadow_ai_requests set status = p_status,
    input_tokens = p_input_tokens, output_tokens = p_output_tokens,
    error_code = case when p_status = 'ok' then null else p_error_code end,
    finished_at = clock_timestamp()
  where id = p_request_id and status = 'reserved';
  return found;
end;
$$;

revoke all on function public.shadow_ai_reserve_request_v1(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.shadow_ai_finish_request_v1(uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.shadow_ai_reserve_request_v1(uuid, uuid, text, text, text) to service_role;
grant execute on function public.shadow_ai_finish_request_v1(uuid, text, integer, integer, text) to service_role;

commit;
