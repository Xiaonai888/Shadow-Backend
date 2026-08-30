begin;

do $$
begin
  if to_regclass('public.user_hashtag_interests') is null then
    execute $create$
      create table public.user_hashtag_interests as
      select
        id as user_id,
        null::bigint as hashtag_id,
        0::numeric(12,4) as interest_score,
        0::bigint as signal_count,
        now()::timestamptz as last_signal_at,
        now()::timestamptz as created_at,
        now()::timestamptz as updated_at
      from public.users
      where false
    $create$;
  end if;
end;
$$;

alter table public.user_hashtag_interests
  alter column user_id set not null,
  alter column hashtag_id set not null,
  alter column interest_score set not null,
  alter column interest_score set default 0,
  alter column signal_count set not null,
  alter column signal_count set default 0,
  alter column last_signal_at set not null,
  alter column last_signal_at set default now(),
  alter column created_at set not null,
  alter column created_at set default now(),
  alter column updated_at set not null,
  alter column updated_at set default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_hashtag_interests_pkey'
      and conrelid = 'public.user_hashtag_interests'::regclass
  ) then
    alter table public.user_hashtag_interests
      add constraint user_hashtag_interests_pkey
      primary key (user_id, hashtag_id);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_hashtag_interests_user_id_fkey'
      and conrelid = 'public.user_hashtag_interests'::regclass
  ) then
    alter table public.user_hashtag_interests
      add constraint user_hashtag_interests_user_id_fkey
      foreign key (user_id)
      references public.users(id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_hashtag_interests_hashtag_id_fkey'
      and conrelid = 'public.user_hashtag_interests'::regclass
  ) then
    alter table public.user_hashtag_interests
      add constraint user_hashtag_interests_hashtag_id_fkey
      foreign key (hashtag_id)
      references public.author_hashtags(id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_hashtag_interests_score_check'
      and conrelid = 'public.user_hashtag_interests'::regclass
  ) then
    alter table public.user_hashtag_interests
      add constraint user_hashtag_interests_score_check
      check (interest_score >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_hashtag_interests_signal_count_check'
      and conrelid = 'public.user_hashtag_interests'::regclass
  ) then
    alter table public.user_hashtag_interests
      add constraint user_hashtag_interests_signal_count_check
      check (signal_count >= 0);
  end if;
end;
$$;

create index if not exists user_hashtag_interests_user_score_idx
  on public.user_hashtag_interests (
    user_id,
    interest_score desc,
    last_signal_at desc
  );

create index if not exists user_hashtag_interests_hashtag_score_idx
  on public.user_hashtag_interests (
    hashtag_id,
    interest_score desc
  );

alter table public.user_hashtag_interests enable row level security;

commit;
