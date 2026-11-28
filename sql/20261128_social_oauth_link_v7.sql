begin;
create table if not exists public.social_oauth_connection_links (
  id uuid primary key,
  actor_id text not null check (char_length(actor_id) between 1 and 128),
  session_hash text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider in ('facebook','threads')),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','exchanging','review','approved','cancelled','failed')),
  staged_rows jsonb,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at>created_at),
  check ((status='review' and staged_rows is not null and jsonb_typeof(staged_rows)='array') or (status<>'review' and staged_rows is null)),
  check ((status='approved' and result is not null and jsonb_typeof(result)='object') or (status<>'approved' and result is null))
);
create index if not exists social_oauth_links_actor_v7_idx on public.social_oauth_connection_links(actor_id,expires_at);
create index if not exists social_oauth_links_expiry_v7_idx on public.social_oauth_connection_links(expires_at);
alter table public.social_oauth_connection_links enable row level security;
revoke all on public.social_oauth_connection_links from public,anon,authenticated;
grant select,insert,update,delete on public.social_oauth_connection_links to service_role;

create or replace function public.social_oauth_link_cleanup_v7()
returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  delete from public.social_oauth_connection_links where id in (select id from public.social_oauth_connection_links where expires_at<=clock_timestamp() order by expires_at limit 100 for update skip locked);
  get diagnostics n=row_count;
  return n;
end;
$$;

create or replace function public.social_oauth_link_issue_v7(p_id uuid,p_actor_id text,p_session_hash text,p_provider text,p_state_hash text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_id is null or p_actor_id is null or char_length(p_actor_id) not between 1 and 128 or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' or p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' or p_provider is null or p_provider not in ('facebook','threads') then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('shadow-social-link:'||p_actor_id,0));
  perform public.social_oauth_link_cleanup_v7();
  update public.social_oauth_connection_links set status='cancelled' where actor_id=p_actor_id and session_hash=p_session_hash and provider=p_provider and status='pending' and expires_at>clock_timestamp();
  if (select count(*) from public.social_oauth_connection_links where actor_id=p_actor_id and status in ('pending','exchanging','review') and expires_at>clock_timestamp())>=5 then return false; end if;
  insert into public.social_oauth_connection_links(id,actor_id,session_hash,provider,state_hash,expires_at) values(p_id,p_actor_id,p_session_hash,p_provider,p_state_hash,clock_timestamp()+interval '15 minutes');
  return true;
end;
$$;

create or replace function public.social_oauth_link_claim_v7(p_state_hash text,p_provider text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare claimed uuid;
begin
  update public.social_oauth_connection_links set status='exchanging',expires_at=clock_timestamp()+interval '3 minutes' where state_hash=p_state_hash and provider=p_provider and status='pending' and expires_at>clock_timestamp() returning id into claimed;
  return claimed;
end;
$$;

create or replace function public.social_oauth_link_stage_v7(p_id uuid,p_rows jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare link_provider text;
begin
  select provider into link_provider from public.social_oauth_connection_links where id=p_id and status='exchanging' and expires_at>clock_timestamp() for update;
  if not found then return false; end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' then return false; end if;
  if jsonb_array_length(p_rows) not between 1 and 200 or exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x)<>'object') then return false; end if;
  if exists(select 1 from jsonb_to_recordset(p_rows) x(platform text,external_id text,display_name text,token_ciphertext text,token_expires_at timestamptz) where platform is null or (link_provider='facebook' and platform not in ('facebook','instagram')) or (link_provider='threads' and platform<>'threads') or external_id is null or external_id !~ '^[0-9]{1,40}$' or display_name is null or char_length(trim(display_name)) not between 1 and 300 or char_length(display_name)>300 or token_ciphertext is null or char_length(token_ciphertext)>100000 or token_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' or (platform in ('instagram','threads') and token_expires_at is null) or (token_expires_at is not null and token_expires_at<=clock_timestamp())) then return false; end if;
  if exists(select 1 from jsonb_to_recordset(p_rows) x(platform text,external_id text) group by platform,external_id having count(*)>1) then return false; end if;
  update public.social_oauth_connection_links set status='review',staged_rows=p_rows,expires_at=clock_timestamp()+interval '15 minutes' where id=p_id;
  return true;
end;
$$;

create or replace function public.social_oauth_link_fail_v7(p_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update public.social_oauth_connection_links set status='failed',staged_rows=null,result=null where id=p_id and status='exchanging';
  return found;
end;
$$;

create or replace function public.social_oauth_link_status_v7(p_id uuid,p_actor_id text,p_session_hash text)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('id',l.id,'provider',l.provider,'status',case when l.expires_at<=now() then 'expired' else l.status end,'expiresAt',l.expires_at,'accounts',case when l.status='review' and l.expires_at>now() then (select coalesce(jsonb_agg(jsonb_build_object('platform',r.platform,'externalId',r.external_id,'displayName',r.display_name) order by r.platform,r.external_id),'[]'::jsonb) from jsonb_to_recordset(l.staged_rows) r(platform text,external_id text,display_name text)) else '[]'::jsonb end,'result',case when l.status='approved' then l.result else null end)
from public.social_oauth_connection_links l where l.id=p_id and l.actor_id=p_actor_id and l.session_hash=p_session_hash;
$$;

create or replace function public.social_oauth_link_approve_v7(p_id uuid,p_actor_id text,p_session_hash text,p_keys text[])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare prior public.social_oauth_connection_links%rowtype; selected jsonb; outcome jsonb;
begin
  if p_keys is null or cardinality(p_keys) not between 1 and 200 or array_position(p_keys,null) is not null or (select count(distinct k) from unnest(p_keys) k)<>cardinality(p_keys) then return null; end if;
  select * into prior from public.social_oauth_connection_links where id=p_id and actor_id=p_actor_id and session_hash=p_session_hash and expires_at>clock_timestamp() for update;
  if not found then return null; end if;
  if prior.status='approved' then return prior.result; end if;
  if prior.status<>'review' then return null; end if;
  select jsonb_agg(x) into selected from jsonb_array_elements(prior.staged_rows) x where (x->>'platform')||':'||(x->>'external_id')=any(p_keys);
  if selected is null or jsonb_array_length(selected)<>cardinality(p_keys) then return null; end if;
  outcome:=public.social_oauth_import_admin_v2(selected);
  update public.social_oauth_connection_links set status='approved',staged_rows=null,result=outcome where id=p_id;
  return outcome;
end;
$$;

create or replace function public.social_oauth_link_cancel_v7(p_id uuid,p_actor_id text,p_session_hash text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update public.social_oauth_connection_links set status='cancelled',staged_rows=null,result=null where id=p_id and actor_id=p_actor_id and session_hash=p_session_hash and status in ('pending','exchanging','review') and expires_at>clock_timestamp();
  return found;
end;
$$;

revoke all on function public.social_oauth_link_cleanup_v7(),public.social_oauth_link_issue_v7(uuid,text,text,text,text),public.social_oauth_link_claim_v7(text,text),public.social_oauth_link_stage_v7(uuid,jsonb),public.social_oauth_link_fail_v7(uuid),public.social_oauth_link_status_v7(uuid,text,text),public.social_oauth_link_approve_v7(uuid,text,text,text[]),public.social_oauth_link_cancel_v7(uuid,text,text) from public,anon,authenticated;
grant execute on function public.social_oauth_link_cleanup_v7(),public.social_oauth_link_issue_v7(uuid,text,text,text,text),public.social_oauth_link_claim_v7(text,text),public.social_oauth_link_stage_v7(uuid,jsonb),public.social_oauth_link_fail_v7(uuid),public.social_oauth_link_status_v7(uuid,text,text),public.social_oauth_link_approve_v7(uuid,text,text,text[]),public.social_oauth_link_cancel_v7(uuid,text,text) to service_role;
commit;
