create or replace function public.apply_story_reaction_states_batch(
  p_user_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_story_id uuid;
  v_reaction_type text;
  v_liked boolean;
  v_occurred_at timestamptz;
  v_existing_id uuid;
  v_existing_type text;
  v_action text;
  v_results jsonb := '[]'::jsonb;
  v_output jsonb := '[]'::jsonb;
begin
  if p_user_id is null then
    raise exception 'User is required';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items must be an array';
  end if;

  if jsonb_array_length(p_items) > 500 then
    raise exception 'Batch limit exceeded';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_items)
    order by value->>'story_id'
  loop
    v_story_id := (v_item->>'story_id')::uuid;
    v_liked := coalesce((v_item->>'liked')::boolean, false);
    v_reaction_type := lower(trim(coalesce(v_item->>'reaction_type', 'love')));

    if v_reaction_type not in (
      'love',
      'haha',
      'wow',
      'sad',
      'angry',
      'support',
      'touched'
    ) then
      v_reaction_type := 'love';
    end if;

    begin
      v_occurred_at := nullif(v_item->>'occurred_at', '')::timestamptz;
    exception
      when others then
        v_occurred_at := null;
    end;

    if v_occurred_at is null
      or v_occurred_at > now() + interval '2 minutes'
      or v_occurred_at < now() - interval '7 days'
    then
      v_occurred_at := now();
    end if;

    if not exists (
      select 1
      from public.stories
      where id = v_story_id
    ) then
      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'ok', false,
          'story_id', v_story_id,
          'message', 'Story not found'
        )
      );
      continue;
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(v_story_id::text || ':' || p_user_id::text, 0)
    );

    v_existing_id := null;
    v_existing_type := null;

    select id, reaction_type
    into v_existing_id, v_existing_type
    from public.story_reactions
    where story_id = v_story_id
      and user_id = p_user_id
      and episode_id is null
    order by created_at asc
    limit 1
    for update;

    if v_liked then
      if v_existing_id is null then
        insert into public.story_reactions (
          user_id,
          story_id,
          episode_id,
          reaction_type,
          created_at
        )
        values (
          p_user_id,
          v_story_id,
          null,
          v_reaction_type,
          v_occurred_at
        );

        v_action := 'added';
      elsif lower(coalesce(v_existing_type, 'love')) <> v_reaction_type then
        update public.story_reactions
        set reaction_type = v_reaction_type
        where id = v_existing_id;

        v_action := 'updated';
      else
        v_action := 'unchanged';
      end if;
    else
      if v_existing_id is not null then
        delete from public.story_reactions
        where story_id = v_story_id
          and user_id = p_user_id
          and episode_id is null;

        v_action := 'removed';
      else
        v_action := 'unchanged';
      end if;
    end if;

    v_results := v_results || jsonb_build_array(
      jsonb_build_object(
        'ok', true,
        'story_id', v_story_id,
        'action', v_action,
        'liked', v_liked,
        'reaction_type', case when v_liked then v_reaction_type else null end,
        'occurred_at', v_occurred_at
      )
    );
  end loop;

  with touched as (
    select distinct (item->>'story_id')::uuid as story_id
    from jsonb_array_elements(v_results) as item
    where coalesce((item->>'ok')::boolean, false)
  ), counts as (
    select
      touched.story_id,
      count(reactions.id)::bigint as total_likes
    from touched
    left join public.story_reactions as reactions
      on reactions.story_id = touched.story_id
      and reactions.episode_id is null
    group by touched.story_id
  )
  update public.stories as stories
  set
    total_likes = counts.total_likes,
    updated_at = now()
  from counts
  where stories.id = counts.story_id;

  select coalesce(
    jsonb_agg(
      result.item || jsonb_build_object(
        'total_likes', coalesce(stories.total_likes, 0),
        'author_id', stories.author_id,
        'story_owner_user_id', stories.user_id
      )
      order by result.ordinality
    ),
    '[]'::jsonb
  )
  into v_output
  from jsonb_array_elements(v_results) with ordinality as result(item, ordinality)
  left join public.stories as stories
    on stories.id = (result.item->>'story_id')::uuid;

  return v_output;
end;
$$;

revoke all on function public.apply_story_reaction_states_batch(uuid, jsonb)
from public, anon, authenticated;

grant execute on function public.apply_story_reaction_states_batch(uuid, jsonb)
to service_role;
