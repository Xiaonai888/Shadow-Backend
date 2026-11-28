begin;

alter table public.social_media_connections drop constraint if exists social_media_connections_platform_check;
alter table public.social_media_connections add constraint social_media_connections_platform_check check (platform in ('facebook','instagram','threads'));
alter table public.social_media_connections add column if not exists oauth_refresh_after timestamptz;
create index if not exists social_media_threads_refresh_v4_idx on public.social_media_connections(token_expires_at,oauth_refresh_after,id) where platform='threads' and owner_type='admin' and owner_id='shadow' and status='connected';

create table if not exists public.social_media_bot_assignments (
  connection_id uuid not null,
  owner_type text not null default 'admin' check (owner_type='admin'),
  owner_id text not null default 'shadow' check (owner_id='shadow'),
  bot_key text not null check (bot_key in ('promotion','event')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(connection_id,bot_key),
  foreign key(connection_id,owner_type,owner_id) references public.social_media_connections(id,owner_type,owner_id) on delete restrict
);
alter table public.social_media_bot_assignments enable row level security;
revoke all on public.social_media_bot_assignments from public,anon,authenticated;
grant select,insert,delete on public.social_media_bot_assignments to service_role;
insert into public.social_media_bot_assignments(connection_id,bot_key)
select distinct connection_id,'promotion' from public.social_promotion_rules where owner_type='admin' and owner_id='shadow' and enabled
on conflict do nothing;

create or replace function public.social_oauth_assign_bot_v4(p_id uuid,p_bot text,p_assigned boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare n integer:=0; rules_count integer:=0; jobs_count integer:=0;
begin
  if p_id is null or p_bot is null or p_bot not in ('promotion','event') or p_assigned is null then raise exception using errcode='22023',message='SOCIAL_BOT_ASSIGNMENT_INVALID'; end if;
  perform 1 from public.social_media_connections where id=p_id and owner_type='admin' and owner_id='shadow' for update;
  if not found then return jsonb_build_object('state','not_found','changed',false,'disabledRules',0,'cancelledJobs',0); end if;
  if p_assigned then
    insert into public.social_media_bot_assignments(connection_id,bot_key) values(p_id,p_bot) on conflict do nothing;
    get diagnostics n=row_count;
  else
    delete from public.social_media_bot_assignments where connection_id=p_id and bot_key=p_bot and owner_type='admin' and owner_id='shadow';
    get diagnostics n=row_count;
    if p_bot='promotion' then
      update public.social_promotion_rules set enabled=false,updated_at=clock_timestamp() where connection_id=p_id and owner_type='admin' and owner_id='shadow' and enabled;
      get diagnostics rules_count=row_count;
      update public.social_media_jobs set status='cancelled',finished_at=clock_timestamp(),error_code='SOCIAL_BOT_UNASSIGNED' where connection_id=p_id and owner_type='admin' and owner_id='shadow' and rule_revision is not null and status='queued';
      get diagnostics jobs_count=row_count;
    end if;
  end if;
  return jsonb_build_object('state',case when p_assigned then 'assigned' else 'unassigned' end,'changed',n>0,'disabledRules',rules_count,'cancelledJobs',jobs_count);
end;
$$;

create or replace function public.social_oauth_bot_list_v4(p_ids uuid[])
returns jsonb language sql stable security invoker set search_path='' as $$
select coalesce(jsonb_agg(jsonb_build_object('connectionId',connection_id,'bot',bot_key) order by connection_id,bot_key),'[]'::jsonb)
from public.social_media_bot_assignments where owner_type='admin' and owner_id='shadow' and cardinality(p_ids) between 1 and 10 and connection_id=any(p_ids);
$$;

create or replace function public.social_threads_refresh_claim_v4()
returns jsonb language sql security invoker set search_path='' as $$
with due as (
  select id from public.social_media_connections
  where owner_type='admin' and owner_id='shadow' and platform='threads' and status='connected' and token_ciphertext is not null
    and token_expires_at>now() and token_expires_at<=now()+interval '7 days' and updated_at<=now()-interval '24 hours'
    and (oauth_refresh_after is null or oauth_refresh_after<=now())
  order by token_expires_at,id limit 5 for update skip locked
), claimed as (
  update public.social_media_connections c set oauth_refresh_after=clock_timestamp()+interval '6 hours' from due where c.id=due.id
  returning c.id,c.external_id,c.token_ciphertext,c.updated_at,c.oauth_refresh_after,c.token_expires_at
)
select coalesce(jsonb_agg(to_jsonb(claimed) order by token_expires_at,id),'[]'::jsonb) from claimed;
$$;

create or replace function public.social_threads_refresh_finish_v4(p_id uuid,p_revision timestamptz,p_lease timestamptz,p_cipher text,p_expires timestamptz,p_reauth boolean default false)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_id is null or p_revision is null or p_lease is null or p_reauth is null or (p_reauth and (p_cipher is not null or p_expires is not null)) or (not p_reauth and (p_cipher is null or char_length(p_cipher)>100000 or p_cipher !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' or p_expires is null or p_expires<=clock_timestamp())) then return false; end if;
  update public.social_media_connections set token_ciphertext=case when p_reauth then token_ciphertext else p_cipher end,
    token_expires_at=case when p_reauth then token_expires_at else p_expires end,
    status=case when p_reauth then 'reauth_required' else 'connected' end,updated_at=clock_timestamp(),oauth_refresh_after=null
  where id=p_id and owner_type='admin' and owner_id='shadow' and platform='threads' and status='connected'
    and updated_at=p_revision and oauth_refresh_after=p_lease and p_lease>clock_timestamp();
  return found;
end;
$$;

revoke all on function public.social_oauth_assign_bot_v4(uuid,text,boolean),public.social_oauth_bot_list_v4(uuid[]),public.social_threads_refresh_claim_v4(),public.social_threads_refresh_finish_v4(uuid,timestamptz,timestamptz,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.social_oauth_assign_bot_v4(uuid,text,boolean),public.social_oauth_bot_list_v4(uuid[]),public.social_threads_refresh_claim_v4(),public.social_threads_refresh_finish_v4(uuid,timestamptz,timestamptz,text,timestamptz,boolean) to service_role;

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
    where platform is null or platform not in ('facebook','instagram','threads')
    or external_id is null or external_id !~ '^[0-9]{1,40}$'
    or display_name is null or char_length(trim(display_name)) not between 1 and 300
    or char_length(display_name)>300
    or token_ciphertext is null or char_length(token_ciphertext)>100000
    or token_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    or (platform in ('instagram','threads') and token_expires_at is null)
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
    display_name=excluded.display_name,token_ciphertext=excluded.token_ciphertext,token_expires_at=excluded.token_expires_at,updated_at=excluded.updated_at,oauth_refresh_after=null
  where existing.status='connected' and (existing.token_expires_at is null or existing.token_expires_at>clock_timestamp());
  get diagnostics affected=row_count;
  return jsonb_build_object('saved',affected,'skipped',row_count_input-affected);
end;
$$;
revoke all on function public.social_oauth_import_admin_v2(jsonb) from public,anon,authenticated;
grant execute on function public.social_oauth_import_admin_v2(jsonb) to service_role;

create or replace function public.social_oauth_reconnect_admin_v3(p_id uuid,p_platform text,p_external_id text,p_display_name text,p_token_ciphertext text,p_token_expires_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  prior public.social_media_connections%rowtype;
  disabled_count integer:=0;
  cancelled_count integer:=0;
begin
  if p_id is null or p_platform is null or p_platform not in ('facebook','instagram','threads')
    or p_external_id is null or p_external_id !~ '^[0-9]{1,40}$'
    or p_display_name is null or char_length(trim(p_display_name)) not between 1 and 300 or char_length(p_display_name)>300
    or p_token_ciphertext is null or char_length(p_token_ciphertext)>100000
    or p_token_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    or (p_platform in ('instagram','threads') and p_token_expires_at is null)
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
  update public.social_media_connections set display_name=trim(p_display_name),token_ciphertext=p_token_ciphertext,token_expires_at=p_token_expires_at,status='connected',updated_at=clock_timestamp(),oauth_refresh_after=null
  where id=p_id and owner_type='admin' and owner_id='shadow';
  return jsonb_build_object('state','connected','disabledRules',disabled_count,'cancelledJobs',cancelled_count);
end;
$$;
revoke all on function public.social_oauth_reconnect_admin_v3(uuid,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.social_oauth_reconnect_admin_v3(uuid,text,text,text,text,timestamptz) to service_role;

commit;
