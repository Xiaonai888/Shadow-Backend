begin;
create or replace function public.social_oauth_reconnect_admin_v3(p_id uuid,p_platform text,p_external_id text,p_display_name text,p_token_ciphertext text,p_token_expires_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  prior public.social_media_connections%rowtype;
  disabled_count integer:=0;
  cancelled_count integer:=0;
begin
  if p_id is null or p_platform is null or p_platform not in ('facebook','instagram')
    or p_external_id is null or p_external_id !~ '^[0-9]{1,40}$'
    or p_display_name is null or char_length(trim(p_display_name)) not between 1 and 300 or char_length(p_display_name)>300
    or p_token_ciphertext is null or char_length(p_token_ciphertext)>100000
    or p_token_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    or (p_platform='instagram' and p_token_expires_at is null)
    or (p_token_expires_at is not null and p_token_expires_at<=clock_timestamp()) then
    raise exception using errcode='22023',message='SOCIAL_OAUTH_RECONNECT_INVALID';
  end if;
  perform pg_advisory_xact_lock(721104,33009);
  select * into prior from public.social_media_connections where id=p_id and owner_type='admin' and owner_id='shadow' for update;
  if not found or prior.platform<>p_platform or prior.external_id<>p_external_id then
    return jsonb_build_object('state','not_found','disabledRules',0,'cancelledJobs',0);
  end if;
  if prior.status<>'connected' or (prior.token_expires_at is not null and prior.token_expires_at<=clock_timestamp()) then
    update public.social_promotion_rules set enabled=false,updated_at=clock_timestamp()
    where connection_id=p_id and owner_type='admin' and owner_id='shadow' and enabled;
    get diagnostics disabled_count=row_count;
    update public.social_media_jobs set status='cancelled',finished_at=clock_timestamp(),error_code='SOCIAL_OAUTH_RECONNECT_REVIEW_REQUIRED'
    where connection_id=p_id and owner_type='admin' and owner_id='shadow' and status='queued';
    get diagnostics cancelled_count=row_count;
  end if;
  update public.social_media_connections set display_name=trim(p_display_name),token_ciphertext=p_token_ciphertext,token_expires_at=p_token_expires_at,status='connected',updated_at=clock_timestamp()
  where id=p_id and owner_type='admin' and owner_id='shadow';
  return jsonb_build_object('state','connected','disabledRules',disabled_count,'cancelledJobs',cancelled_count);
end;
$$;
revoke all on function public.social_oauth_reconnect_admin_v3(uuid,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.social_oauth_reconnect_admin_v3(uuid,text,text,text,text,timestamptz) to service_role;
commit;
