begin;
create table if not exists public.shadow_ai_gemini_learning_candidates (
  example_id text primary key check (example_id in ('price_km','stock_km','delivery_km','signature_km','schedule_km','requirements_km','books_km','price_en','stock_en','delivery_en')),
  expected_version integer not null check (expected_version >= 1),
  created_at timestamptz not null default now()
);
alter table public.shadow_ai_gemini_learning_candidates enable row level security;
revoke all on public.shadow_ai_gemini_learning_candidates from public, anon, authenticated, service_role;

create or replace function public.shadow_ai_gemini_list_learning_candidates_v1()
returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(jsonb_agg(jsonb_build_object('example_id', example_id, 'expected_version', expected_version) order by example_id), '[]'::jsonb)
  from public.shadow_ai_gemini_learning_candidates;
$$;

create or replace function public.shadow_ai_gemini_save_learning_candidates_v1(p_example_ids text[], p_expected_version integer)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_inserted integer;
begin
  if p_expected_version is null or p_expected_version < 1 or p_example_ids is null or cardinality(p_example_ids) not between 1 and 5 or array_ndims(p_example_ids) <> 1 then
    raise exception 'Invalid learning candidate batch' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_example_ids) as item(id) where id is null or id not in ('price_km','stock_km','delivery_km','signature_km','schedule_km','requirements_km','books_km','price_en','stock_en','delivery_en')) then
    raise exception 'Invalid learning candidate example' using errcode = '22023';
  end if;
  insert into public.shadow_ai_gemini_learning_candidates(example_id, expected_version)
    select distinct id, p_expected_version from unnest(p_example_ids) as item(id)
    on conflict (example_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;
revoke all on function public.shadow_ai_gemini_list_learning_candidates_v1() from public, anon, authenticated, service_role;
revoke all on function public.shadow_ai_gemini_save_learning_candidates_v1(text[], integer) from public, anon, authenticated, service_role;
grant execute on function public.shadow_ai_gemini_list_learning_candidates_v1() to service_role;
grant execute on function public.shadow_ai_gemini_save_learning_candidates_v1(text[], integer) to service_role;
commit;
