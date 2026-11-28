begin;

create or replace function public.social_oauth_import_admin_v2(p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  row_count_input integer;
  affected integer;
begin
  if p_rows is null or jsonb_typeof(p_rows)<>'array' then
    raise exception using errcode='22023',message='SOCIAL_OAUTH_IMPORT_INVALID';
  end if;
  row_count_input:=jsonb_array_length(p_rows);
  if row_count_input>200 then raise exception using errcode='22023',message='SOCIAL_OAUTH_IMPORT_LIMIT'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x)<>'object') then
    raise exception using errcode='22023',message='SOCIAL_OAUTH_IMPORT_INVALID';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_rows) x(platform text,external_id text,display_name text,token_ciphertext text,token_expires_at timestamptz)
    where platform is null or platform not in ('facebook','instagram')
    or external_id is null or external_id !~ '^[0-9]{1,40}$'
    or display_name is null or char_length(trim(display_name)) not between 1 and 300
    or char_length(display_name)>300
    or token_ciphertext is null or char_length(token_ciphertext)>100000
    or token_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    or (platform='instagram' and token_expires_at is null)
    or (token_expires_at is not null and token_expires_at<=clock_timestamp())) then
    raise exception using errcode='22023',message='SOCIAL_OAUTH_IMPORT_INVALID';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_rows) x(platform text,external_id text) group by platform,external_id having count(*)>1) then
    raise exception using errcode='22023',message='SOCIAL_OAUTH_IMPORT_DUPLICATE';
  end if;
  perform pg_advisory_xact_lock(721104,33009);
  insert into public.social_media_connections as existing(owner_type,owner_id,platform,external_id,display_name,token_ciphertext,token_expires_at,status,updated_at)
  select 'admin','shadow',x.platform,x.external_id,trim(x.display_name),x.token_ciphertext,x.token_expires_at,'connected',clock_timestamp()
  from jsonb_to_recordset(p_rows) x(platform text,external_id text,display_name text,token_ciphertext text,token_expires_at timestamptz)
  order by x.platform,x.external_id
  on conflict(owner_type,owner_id,platform,external_id) do update set
    display_name=excluded.display_name,token_ciphertext=excluded.token_ciphertext,token_expires_at=excluded.token_expires_at,updated_at=excluded.updated_at
  where existing.status='connected';
  get diagnostics affected=row_count;
  return jsonb_build_object('saved',affected,'skipped',row_count_input-affected);
end;
$$;
revoke all on function public.social_oauth_import_admin_v2(jsonb) from public,anon,authenticated;
grant execute on function public.social_oauth_import_admin_v2(jsonb) to service_role;
commit;
