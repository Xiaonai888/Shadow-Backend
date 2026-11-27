begin;

create table if not exists public.shadow_ai_local_knowledge_versions (
  version integer primary key check (version >= 1),
  aliases jsonb not null check (jsonb_typeof(aliases) = 'array' and jsonb_array_length(aliases) <= 250 and octet_length(aliases::text) <= 32768),
  created_by text not null check (char_length(created_by) between 1 and 128),
  created_at timestamptz not null default now(),
  source_version integer references public.shadow_ai_local_knowledge_versions(version),
  check (source_version is null or source_version < version)
);
create table if not exists public.shadow_ai_local_knowledge_state (
  id smallint primary key check (id = 1),
  active_version integer not null references public.shadow_ai_local_knowledge_versions(version)
);
insert into public.shadow_ai_local_knowledge_versions(version,aliases,created_by)
values (1,'[]'::jsonb,'system') on conflict (version) do nothing;
insert into public.shadow_ai_local_knowledge_state(id,active_version)
values (1,1) on conflict (id) do nothing;

alter table public.shadow_ai_local_knowledge_versions enable row level security;
alter table public.shadow_ai_local_knowledge_state enable row level security;
revoke all on public.shadow_ai_local_knowledge_versions,public.shadow_ai_local_knowledge_state from public,anon,authenticated,service_role;
grant select on public.shadow_ai_local_knowledge_versions,public.shadow_ai_local_knowledge_state to service_role;

create or replace function public.shadow_ai_local_knowledge_read_v1(p_version integer default null)
returns jsonb language sql stable set search_path = pg_catalog,public as $$
  select jsonb_build_object('version',v.version,'aliases',v.aliases,'created_at',v.created_at,'source_version',v.source_version)
  from public.shadow_ai_local_knowledge_versions v
  where v.version=coalesce(p_version,(select active_version from public.shadow_ai_local_knowledge_state where id=1));
$$;

create or replace function public.shadow_ai_local_knowledge_publish_v1(p_expected_version integer,p_aliases jsonb,p_admin_id text,p_source_version integer default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare
  v_current integer;
  v_next integer;
  v_alias jsonb;
begin
  if p_expected_version is null or p_expected_version<1 or p_admin_id is null
    or char_length(btrim(p_admin_id)) not between 1 and 128
    or p_aliases is null or jsonb_typeof(p_aliases)<>'array' then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_KNOWLEDGE_INVALID');
  end if;
  if jsonb_array_length(p_aliases)>250 or octet_length(p_aliases::text)>32768 then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_KNOWLEDGE_INVALID');
  end if;
  for v_alias in select value from jsonb_array_elements(p_aliases) loop
    if jsonb_typeof(v_alias)<>'object' then
      return jsonb_build_object('ok',false,'code','SHADOW_AI_KNOWLEDGE_INVALID');
    end if;
    if not (v_alias ?& array['group','alias','canonical']) or (select count(*) from jsonb_object_keys(v_alias))<>3
      or jsonb_typeof(v_alias->'group')<>'string' or jsonb_typeof(v_alias->'alias')<>'string' or jsonb_typeof(v_alias->'canonical')<>'string'
      or v_alias->>'group' not in ('fields','editions','questions')
      or char_length(v_alias->>'alias') not between 2 and 80
      or char_length(v_alias->>'canonical') not between 1 and 64 then
      return jsonb_build_object('ok',false,'code','SHADOW_AI_KNOWLEDGE_INVALID');
    end if;
  end loop;
  select active_version into v_current from public.shadow_ai_local_knowledge_state where id=1 for update;
  if not found or v_current<>p_expected_version then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_KNOWLEDGE_CONFLICT');
  end if;
  if p_source_version is not null and (p_source_version>=v_current or not exists (
    select 1 from public.shadow_ai_local_knowledge_versions where version=p_source_version and aliases=p_aliases
  )) then
    return jsonb_build_object('ok',false,'code','SHADOW_AI_KNOWLEDGE_INVALID');
  end if;
  if exists (select 1 from public.shadow_ai_local_knowledge_versions where version=v_current and aliases=p_aliases) then
    return jsonb_build_object('ok',true,'version',v_current,'changed',false);
  end if;
  v_next:=v_current+1;
  insert into public.shadow_ai_local_knowledge_versions(version,aliases,created_by,source_version)
  values(v_next,p_aliases,btrim(p_admin_id),p_source_version);
  update public.shadow_ai_local_knowledge_state set active_version=v_next where id=1;
  return jsonb_build_object('ok',true,'version',v_next,'changed',true);
end;
$$;

revoke all on function public.shadow_ai_local_knowledge_read_v1(integer) from public,anon,authenticated;
revoke all on function public.shadow_ai_local_knowledge_publish_v1(integer,jsonb,text,integer) from public,anon,authenticated;
grant execute on function public.shadow_ai_local_knowledge_read_v1(integer) to service_role;
grant execute on function public.shadow_ai_local_knowledge_publish_v1(integer,jsonb,text,integer) to service_role;
commit;
