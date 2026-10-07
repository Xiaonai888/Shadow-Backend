alter table public.story_reactions
add column if not exists occurred_at timestamptz;

alter table public.story_reactions
add column if not exists processed_at timestamptz;

update public.story_reactions
set occurred_at = coalesce(occurred_at, created_at, now())
where occurred_at is null;

update public.story_reactions
set processed_at = coalesce(processed_at, now())
where processed_at is null;

delete from public.story_reactions
where id in (
  select id
  from (
    select
      id,
      row_number() over (
        partition by story_id, user_id
        order by created_at desc nulls last, id::text desc
      ) as row_number
    from public.story_reactions
    where episode_id is null
  ) duplicates
  where duplicates.row_number > 1
);

create unique index if not exists story_reactions_story_user_unique
on public.story_reactions (story_id, user_id)
where episode_id is null;

create table if not exists public.story_reaction_state_versions (
  user_id uuid not null,
  story_id uuid not null,
  last_event_id uuid not null,
  last_occurred_at timestamptz not null,
  last_liked boolean not null default false,
  last_reaction_type text,
  updated_at timestamptz not null default now(),
  primary key (user_id, story_id)
);

insert into public.story_reaction_state_versions (
  user_id,
  story_id,
  last_event_id,
  last_occurred_at,
  last_liked,
  last_reaction_type,
  updated_at
)
select
  reactions.user_id,
  reactions.story_id,
  md5(
    reactions.user_id::text ||
    ':' ||
    reactions.story_id::text ||
    ':' ||
    coalesce(reactions.occurred_at, reactions.created_at, now())::text
  )::uuid,
  coalesce(reactions.occurred_at, reactions.created_at, now()),
  true,
  lower(coalesce(reactions.reaction_type, 'love')),
  now()
from public.story_reactions reactions
where reactions.episode_id is null
on conflict (user_id, story_id) do nothing;

create or replace function public.apply_story_reaction_states_multi_batch(
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_user_id uuid;
  v_story_id uuid;
  v_event_id uuid;
  v_liked boolean;
  v_reaction_type text;
  v_occurred_at timestamptz;
  v_existing_id uuid;
  v_existing_type text;
  v_last_event_id uuid;
  v_last_occurred_at timestamptz;
  v_action text;
  v_delta integer;
  v_author_id uuid;
  v_owner_user_id uuid;
  v_total_likes bigint;
  v_results jsonb := '[]'::jsonb;
  v_output jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items must be an array';
  end if;

  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Batch limit exceeded';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_items)
    order by
      value->>'user_id',
      value->>'story_id',
      value->>'occurred_at',
      value->>'event_id'
  loop
    begin
      v_user_id := nullif(v_item->>'user_id', '')::uuid;
      v_story_id := nullif(v_item->>'story_id', '')::uuid;
    exception
      when others then
        v_results := v_results || jsonb_build_array(
          jsonb_build_object(
            'ok', false,
            'user_id', v_item->>'user_id',
            'story_id', v_item->>'story_id',
            'message', 'Invalid reaction target'
          )
        );
        continue;
    end;

    if v_user_id is null or v_story_id is null then
      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'ok', false,
          'user_id', v_item->>'user_id',
          'story_id', v_item->>'story_id',
          'message', 'Reaction target is required'
        )
      );
      continue;
    end if;

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

    if
      v_occurred_at is null
      or v_occurred_at > now() + interval '5 minutes'
      or v_occurred_at < now() - interval '7 days'
    then
      v_occurred_at := now();
    end if;

    begin
      v_event_id := nullif(v_item->>'event_id', '')::uuid;
    exception
      when others then
        v_event_id := null;
    end;

    if v_event_id is null then
      v_event_id := md5(
        v_user_id::text ||
        ':' ||
        v_story_id::text ||
        ':' ||
        v_occurred_at::text ||
        ':' ||
        v_liked::text ||
        ':' ||
        v_reaction_type
      )::uuid;
    end if;

    select
      stories.author_id,
      stories.user_id
    into
      v_author_id,
      v_owner_user_id
    from public.stories stories
    where stories.id = v_story_id;

    if not found then
      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'ok', false,
          'user_id', v_user_id,
          'story_id', v_story_id,
          'event_id', v_event_id,
          'message', 'Story not found'
        )
      );
      continue;
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        v_story_id::text || ':' || v_user_id::text,
        0
      )
    );

    v_last_event_id := null;
    v_last_occurred_at := null;

    select
      versions.last_event_id,
      versions.last_occurred_at
    into
      v_last_event_id,
      v_last_occurred_at
    from public.story_reaction_state_versions versions
    where versions.user_id = v_user_id
      and versions.story_id = v_story_id
    for update;

    if
      v_last_occurred_at is not null
      and (
        v_occurred_at < v_last_occurred_at
        or (
          v_occurred_at = v_last_occurred_at
          and v_event_id::text <= v_last_event_id::text
        )
      )
    then
      select
        reactions.id,
        reactions.reaction_type
      into
        v_existing_id,
        v_existing_type
      from public.story_reactions reactions
      where reactions.story_id = v_story_id
        and reactions.user_id = v_user_id
        and reactions.episode_id is null
      limit 1;

      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'ok', true,
          'user_id', v_user_id,
          'story_id', v_story_id,
          'event_id', v_event_id,
          'action', 'stale_ignored',
          'liked', v_existing_id is not null,
          'reaction_type',
            case
              when v_existing_id is not null
                then lower(coalesce(v_existing_type, 'love'))
              else null
            end,
          'occurred_at', v_occurred_at,
          'author_id', v_author_id,
          'owner_user_id', v_owner_user_id,
          'delta', 0
        )
      );

      continue;
    end if;

    v_existing_id := null;
    v_existing_type := null;
    v_delta := 0;

    select
      reactions.id,
      reactions.reaction_type
    into
      v_existing_id,
      v_existing_type
    from public.story_reactions reactions
    where reactions.story_id = v_story_id
      and reactions.user_id = v_user_id
      and reactions.episode_id is null
    limit 1
    for update;

    if v_liked then
      if v_existing_id is null then
        insert into public.story_reactions (
          user_id,
          story_id,
          episode_id,
          reaction_type,
          created_at,
          occurred_at,
          processed_at
        )
        values (
          v_user_id,
          v_story_id,
          null,
          v_reaction_type,
          v_occurred_at,
          v_occurred_at,
          now()
        );

        v_action := 'added';
        v_delta := 1;
      elsif lower(coalesce(v_existing_type, 'love')) <> v_reaction_type then
        update public.story_reactions
        set
          reaction_type = v_reaction_type,
          occurred_at = v_occurred_at,
          processed_at = now()
        where id = v_existing_id;

        v_action := 'updated';
      else
        update public.story_reactions
        set
          occurred_at = v_occurred_at,
          processed_at = now()
        where id = v_existing_id;

        v_action := 'unchanged';
      end if;
    else
      if v_existing_id is not null then
        delete from public.story_reactions
        where id = v_existing_id;

        v_action := 'removed';
        v_delta := -1;
      else
        v_action := 'unchanged';
      end if;
    end if;

    insert into public.story_reaction_state_versions (
      user_id,
      story_id,
      last_event_id,
      last_occurred_at,
      last_liked,
      last_reaction_type,
      updated_at
    )
    values (
      v_user_id,
      v_story_id,
      v_event_id,
      v_occurred_at,
      v_liked,
      case when v_liked then v_reaction_type else null end,
      now()
    )
    on conflict (user_id, story_id)
    do update set
      last_event_id = excluded.last_event_id,
      last_occurred_at = excluded.last_occurred_at,
      last_liked = excluded.last_liked,
      last_reaction_type = excluded.last_reaction_type,
      updated_at = excluded.updated_at;

    v_results := v_results || jsonb_build_array(
      jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'story_id', v_story_id,
        'event_id', v_event_id,
        'action', v_action,
        'liked', v_liked,
        'reaction_type', case when v_liked then v_reaction_type else null end,
        'occurred_at', v_occurred_at,
        'author_id', v_author_id,
        'owner_user_id', v_owner_user_id,
        'delta', v_delta
      )
    );
  end loop;

  with deltas as (
    select
      (item->>'story_id')::uuid as story_id,
      sum(coalesce((item->>'delta')::integer, 0)) as delta
    from jsonb_array_elements(v_results) item
    where
      coalesce((item->>'ok')::boolean, false)
      and coalesce((item->>'delta')::integer, 0) <> 0
    group by (item->>'story_id')::uuid
  )
  update public.stories stories
  set
    total_likes = greatest(
      0,
      coalesce(stories.total_likes, 0) + deltas.delta
    ),
    updated_at = now()
  from deltas
  where stories.id = deltas.story_id;

  for v_item in
    select value
    from jsonb_array_elements(v_results)
  loop
    if coalesce((v_item->>'ok')::boolean, false) then
      select coalesce(stories.total_likes, 0)
      into v_total_likes
      from public.stories stories
      where stories.id = (v_item->>'story_id')::uuid;

      v_output := v_output || jsonb_build_array(
        (v_item - 'delta') ||
        jsonb_build_object(
          'total_likes', coalesce(v_total_likes, 0),
          'processed_at', now()
        )
      );
    else
      v_output := v_output || jsonb_build_array(
        v_item - 'delta'
      );
    end if;
  end loop;

  return v_output;
end;
$$;

create or replace function public.apply_story_reaction_states_batch(
  p_user_id uuid,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
begin
  if p_user_id is null then
    raise exception 'User is required';
  end if;

  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'Events must be an array';
  end if;

  select coalesce(
    jsonb_agg(
      event.value ||
      jsonb_build_object(
        'user_id',
        p_user_id
      )
    ),
    '[]'::jsonb
  )
  into v_items
  from jsonb_array_elements(p_events) event(value);

  return public.apply_story_reaction_states_multi_batch(
    v_items
  );
end;
$$;

revoke all
on function public.apply_story_reaction_states_multi_batch(jsonb)
from public, anon, authenticated;

grant execute
on function public.apply_story_reaction_states_multi_batch(jsonb)
to service_role;

revoke all
on function public.apply_story_reaction_states_batch(uuid, jsonb)
from public, anon, authenticated;

grant execute
on function public.apply_story_reaction_states_batch(uuid, jsonb)
to service_role;
