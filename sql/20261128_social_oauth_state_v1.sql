begin;
create table if not exists public.social_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  actor_id text not null check (char_length(actor_id) between 1 and 128),
  session_hash text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider in ('facebook','threads')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);
create index if not exists social_oauth_states_actor_v1_idx on public.social_oauth_states(actor_id,expires_at);
create index if not exists social_oauth_states_expiry_v1_idx on public.social_oauth_states(expires_at);
alter table public.social_oauth_states enable row level security;
revoke all on public.social_oauth_states from public,anon,authenticated;
grant select,insert,delete on public.social_oauth_states to service_role;

create or replace function public.social_oauth_state_issue_v1(p_state_hash text,p_actor_id text,p_session_hash text,p_provider text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' or p_actor_id is null or char_length(p_actor_id) not between 1 and 128 or p_provider is null or p_provider not in ('facebook','threads') then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('shadow-social-oauth:'||p_actor_id,0));
  delete from public.social_oauth_states where state_hash in (select state_hash from public.social_oauth_states where expires_at<=clock_timestamp() order by expires_at limit 100 for update skip locked);
  if (select count(*) from public.social_oauth_states where actor_id=p_actor_id and expires_at>clock_timestamp())>=5 then return false; end if;
  insert into public.social_oauth_states(state_hash,actor_id,session_hash,provider,expires_at) values(p_state_hash,p_actor_id,p_session_hash,p_provider,clock_timestamp()+interval '10 minutes');
  return true;
end;
$$;

create or replace function public.social_oauth_state_consume_v1(p_state_hash text,p_actor_id text,p_session_hash text,p_provider text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  delete from public.social_oauth_states where state_hash=p_state_hash and actor_id=p_actor_id and session_hash=p_session_hash and provider=p_provider and expires_at>clock_timestamp();
  return found;
end;
$$;
revoke all on function public.social_oauth_state_issue_v1(text,text,text,text),public.social_oauth_state_consume_v1(text,text,text,text) from public,anon,authenticated;
grant execute on function public.social_oauth_state_issue_v1(text,text,text,text),public.social_oauth_state_consume_v1(text,text,text,text) to service_role;
commit;
