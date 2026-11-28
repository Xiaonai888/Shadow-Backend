begin;
create or replace function public.shadow_ai_gemini_approve_learning_candidates_v1(p_example_ids text[], p_expected_version integer, p_aliases jsonb, p_admin_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_count integer;
  v_current integer;
  v_old jsonb;
  v_result jsonb;
  v_removed integer;
begin
  if p_example_ids is null or cardinality(p_example_ids) not between 1 and 10 or array_ndims(p_example_ids) <> 1 or p_expected_version is null or p_expected_version not between 1 and 2147483646 or p_aliases is null or jsonb_typeof(p_aliases) <> 'array' then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_KNOWLEDGE_INVALID');
  end if;
  if exists (select 1 from unnest(p_example_ids) as item(id) where id is null or id not in ('price_km','stock_km','delivery_km','signature_km','schedule_km','requirements_km','books_km','price_en','stock_en','delivery_en')) or (select count(distinct id) from unnest(p_example_ids) as item(id)) <> cardinality(p_example_ids) then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_KNOWLEDGE_INVALID');
  end if;
  select active_version into v_current from public.shadow_ai_local_knowledge_state where id=1 for update;
  if not found or v_current <> p_expected_version then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_GEMINI_APPROVAL_CONFLICT');
  end if;
  select aliases into v_old from public.shadow_ai_local_knowledge_versions where version=v_current;
  if not found or not (p_aliases @> v_old) or jsonb_array_length(p_aliases) > jsonb_array_length(v_old) + cardinality(p_example_ids) then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_KNOWLEDGE_INVALID');
  end if;
  perform example_id from public.shadow_ai_gemini_learning_candidates where example_id=any(p_example_ids) and expected_version<=p_expected_version order by example_id for update;
  get diagnostics v_count = row_count;
  if v_count <> cardinality(p_example_ids) then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_GEMINI_APPROVAL_CONFLICT');
  end if;
  v_result := public.shadow_ai_local_knowledge_publish_v1(p_expected_version,p_aliases,p_admin_id,null);
  if v_result->'ok' is distinct from 'true'::jsonb then
    return v_result;
  end if;
  delete from public.shadow_ai_gemini_learning_candidates where example_id=any(p_example_ids);
  get diagnostics v_removed = row_count;
  if v_removed <> v_count then
    raise exception 'Learning candidate approval conflict';
  end if;
  return v_result || jsonb_build_object('approved_count',v_removed);
end;
$$;
revoke all on function public.shadow_ai_gemini_approve_learning_candidates_v1(text[],integer,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.shadow_ai_gemini_approve_learning_candidates_v1(text[],integer,jsonb,text) to service_role;
commit;
