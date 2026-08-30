begin;

create or replace function public.apply_user_hashtag_interest_signal(
  p_user_id text,
  p_hashtag_id bigint,
  p_signal text
)
returns table(
  hashtag_id bigint,
  interest_score numeric,
  signal_count bigint,
  last_signal_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signal text;
  v_weight numeric(12,4);
  v_now timestamptz := now();
begin
  v_signal := lower(trim(coalesce(p_signal, '')));

  v_weight := case v_signal
    when 'hashtag_click' then 1.0000
    when 'search' then 1.5000
    when 'reaction' then 3.0000
    when 'comment' then 5.0000
    when 'echo' then 6.0000
    when 'follow' then 8.0000
    else null
  end;

  if v_weight is null then
    raise exception 'Unsupported hashtag interest signal: %', p_signal;
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
  ) then
    raise exception 'Hashtag not found';
  end if;

  insert into public.user_hashtag_interests (
    user_id,
    hashtag_id,
    interest_score,
    signal_count,
    last_signal_at,
    created_at,
    updated_at
  )
  select
    u.id,
    p_hashtag_id,
    v_weight,
    1,
    v_now,
    v_now,
    v_now
  from public.users u
  where u.id::text = p_user_id
  on conflict (user_id, hashtag_id)
  do update set
    interest_score = least(
      100::numeric,
      round(
        (
          public.user_hashtag_interests.interest_score *
          power(
            0.5::numeric,
            (
              greatest(
                extract(
                  epoch from (
                    v_now -
                    public.user_hashtag_interests.last_signal_at
                  )
                ),
                0
              ) /
              86400 /
              30
            )::numeric
          ) +
          excluded.interest_score
        )::numeric,
        4
      )
    ),
    signal_count =
      public.user_hashtag_interests.signal_count + 1,
    last_signal_at = v_now,
    updated_at = v_now;

  return query
  select
    i.hashtag_id,
    i.interest_score,
    i.signal_count,
    i.last_signal_at
  from public.user_hashtag_interests i
  where i.user_id::text = p_user_id
    and i.hashtag_id = p_hashtag_id;
end;
$$;

revoke all on function public.apply_user_hashtag_interest_signal(
  text,
  bigint,
  text
)
from public, anon, authenticated;

commit;
