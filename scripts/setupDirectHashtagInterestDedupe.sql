begin;

do $$
begin
  if to_regclass('public.user_hashtag_direct_signal_claims') is null then
    execute $create$
      create table public.user_hashtag_direct_signal_claims as
      select
        u.id as user_id,
        null::bigint as hashtag_id,
        ''::text as signal,
        now()::timestamptz as last_signal_at
      from public.users u
      where false
    $create$;
  end if;
end;
$$;

alter table public.user_hashtag_direct_signal_claims
  alter column user_id set not null,
  alter column hashtag_id set not null,
  alter column signal set not null,
  alter column last_signal_at set not null,
  alter column last_signal_at set default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_hashtag_direct_signal_claims_pkey'
      and conrelid = 'public.user_hashtag_direct_signal_claims'::regclass
  ) then
    alter table public.user_hashtag_direct_signal_claims
      add constraint user_hashtag_direct_signal_claims_pkey
      primary key (user_id, hashtag_id, signal);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_hashtag_direct_signal_claims_user_id_fkey'
      and conrelid = 'public.user_hashtag_direct_signal_claims'::regclass
  ) then
    alter table public.user_hashtag_direct_signal_claims
      add constraint user_hashtag_direct_signal_claims_user_id_fkey
      foreign key (user_id)
      references public.users(id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_hashtag_direct_signal_claims_hashtag_id_fkey'
      and conrelid = 'public.user_hashtag_direct_signal_claims'::regclass
  ) then
    alter table public.user_hashtag_direct_signal_claims
      add constraint user_hashtag_direct_signal_claims_hashtag_id_fkey
      foreign key (hashtag_id)
      references public.author_hashtags(id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_hashtag_direct_signal_claims_signal_check'
      and conrelid = 'public.user_hashtag_direct_signal_claims'::regclass
  ) then
    alter table public.user_hashtag_direct_signal_claims
      add constraint user_hashtag_direct_signal_claims_signal_check
      check (signal in ('hashtag_click', 'search'));
  end if;
end;
$$;

alter table public.user_hashtag_direct_signal_claims
  enable row level security;

create or replace function public.apply_user_hashtag_direct_interest_signal(
  p_user_id text,
  p_hashtag_id bigint,
  p_signal text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signal text;
  v_now timestamptz := now();
  v_claimed boolean := false;
begin
  v_signal := lower(trim(coalesce(p_signal, '')));

  if v_signal not in ('hashtag_click', 'search') then
    raise exception 'Unsupported direct hashtag interest signal: %', p_signal;
  end if;

  if not exists (
    select 1
    from public.users u
    where u.id::text = p_user_id
  ) then
    raise exception 'User not found';
  end if;

  if not exists (
    select 1
    from public.author_hashtags h
    where h.id = p_hashtag_id
      and h.usage_count > 0
  ) then
    return 0;
  end if;

  with claimed as (
    insert into public.user_hashtag_direct_signal_claims (
      user_id,
      hashtag_id,
      signal,
      last_signal_at
    )
    select
      u.id,
      p_hashtag_id,
      v_signal,
      v_now
    from public.users u
    where u.id::text = p_user_id
    on conflict (user_id, hashtag_id, signal)
    do update set
      last_signal_at = excluded.last_signal_at
    where public.user_hashtag_direct_signal_claims.last_signal_at
      <= v_now - interval '30 minutes'
    returning 1
  )
  select exists(select 1 from claimed)
  into v_claimed;

  if not v_claimed then
    return 0;
  end if;

  perform *
  from public.apply_user_hashtag_interest_signal(
    p_user_id,
    p_hashtag_id,
    v_signal
  );

  return 1;
end;
$$;

revoke all on function public.apply_user_hashtag_direct_interest_signal(
  text,
  bigint,
  text
)
from public, anon, authenticated;

commit;
