begin;

do $$
begin
  if to_regclass('public.user_post_interest_signal_claims') is null then
    execute $create$
      create table public.user_post_interest_signal_claims as
      select
        u.id as user_id,
        p.id as post_id,
        ''::text as signal,
        now()::timestamptz as created_at
      from public.users u
      cross join public.author_page_posts p
      where false
    $create$;
  end if;
end;
$$;

alter table public.user_post_interest_signal_claims
  alter column user_id set not null,
  alter column post_id set not null,
  alter column signal set not null,
  alter column created_at set not null,
  alter column created_at set default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_post_interest_signal_claims_pkey'
      and conrelid = 'public.user_post_interest_signal_claims'::regclass
  ) then
    alter table public.user_post_interest_signal_claims
      add constraint user_post_interest_signal_claims_pkey
      primary key (user_id, post_id, signal);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_post_interest_signal_claims_user_id_fkey'
      and conrelid = 'public.user_post_interest_signal_claims'::regclass
  ) then
    alter table public.user_post_interest_signal_claims
      add constraint user_post_interest_signal_claims_user_id_fkey
      foreign key (user_id)
      references public.users(id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_post_interest_signal_claims_post_id_fkey'
      and conrelid = 'public.user_post_interest_signal_claims'::regclass
  ) then
    alter table public.user_post_interest_signal_claims
      add constraint user_post_interest_signal_claims_post_id_fkey
      foreign key (post_id)
      references public.author_page_posts(id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_post_interest_signal_claims_signal_check'
      and conrelid = 'public.user_post_interest_signal_claims'::regclass
  ) then
    alter table public.user_post_interest_signal_claims
      add constraint user_post_interest_signal_claims_signal_check
      check (signal in ('reaction', 'comment', 'echo'));
  end if;
end;
$$;

create index if not exists user_post_interest_signal_claims_post_idx
  on public.user_post_interest_signal_claims (post_id, signal);

alter table public.user_post_interest_signal_claims enable row level security;

create or replace function public.apply_user_post_hashtag_interest_signal(
  p_user_id text,
  p_post_id text,
  p_signal text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_applied integer := 0;
  v_signal text;
  v_claimed boolean := false;
begin
  v_signal := lower(trim(coalesce(p_signal, '')));

  if v_signal not in ('reaction', 'comment', 'echo') then
    raise exception 'Unsupported post hashtag interest signal: %', p_signal;
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
    from public.author_page_posts p
    where p.id::text = p_post_id
      and p.status = 'active'
  ) then
    return 0;
  end if;

  with inserted as (
    insert into public.user_post_interest_signal_claims (
      user_id,
      post_id,
      signal
    )
    select
      u.id,
      p.id,
      v_signal
    from public.users u
    cross join public.author_page_posts p
    where u.id::text = p_user_id
      and p.id::text = p_post_id
    on conflict (user_id, post_id, signal)
    do nothing
    returning 1
  )
  select exists(select 1 from inserted)
  into v_claimed;

  if not v_claimed then
    return 0;
  end if;

  for v_item in
    select distinct aph.hashtag_id
    from public.author_post_hashtags aph
    where aph.post_id::text = p_post_id
    limit 20
  loop
    perform *
    from public.apply_user_hashtag_interest_signal(
      p_user_id,
      v_item.hashtag_id,
      v_signal
    );

    v_applied := v_applied + 1;
  end loop;

  return v_applied;
end;
$$;

revoke all on function public.apply_user_post_hashtag_interest_signal(
  text,
  text,
  text
)
from public, anon, authenticated;

commit;
