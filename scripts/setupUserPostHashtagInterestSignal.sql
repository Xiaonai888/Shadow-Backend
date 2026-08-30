begin;

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
begin
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
      p_signal
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
