begin;
create or replace function public.shadow_ai_local_knowledge_history_v1(p_before integer default null,p_limit integer default 20)
returns jsonb language plpgsql stable set search_path=pg_catalog,public as $$
declare
  result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 30 or (p_before is not null and p_before<1) then
    raise exception 'SHADOW_AI_KNOWLEDGE_INVALID';
  end if;
  with candidates as materialized (
    select version,created_at,source_version,jsonb_array_length(aliases) as alias_count
    from public.shadow_ai_local_knowledge_versions
    where p_before is null or version<p_before
    order by version desc limit p_limit+1
  ), page_rows as (
    select * from candidates order by version desc limit p_limit
  )
  select jsonb_build_object('versions',coalesce((select jsonb_agg(to_jsonb(p) order by version desc) from page_rows p),'[]'::jsonb),
    'has_more',(select count(*)>p_limit from candidates),
    'next_before',case when (select count(*)>p_limit from candidates) then (select min(version) from page_rows) else null end)
  into result;
  return result;
end;
$$;
revoke all on function public.shadow_ai_local_knowledge_history_v1(integer,integer) from public,anon,authenticated;
grant execute on function public.shadow_ai_local_knowledge_history_v1(integer,integer) to service_role;
commit;
