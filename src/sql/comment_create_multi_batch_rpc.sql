create or replace function public.create_story_comments_multi_batch_once(
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_result jsonb;
  v_comment jsonb;
  v_results jsonb := '[]'::jsonb;
  v_request_key text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items must be an array';
  end if;

  if jsonb_array_length(p_items) > 200 then
    raise exception 'Batch limit exceeded';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_items)
  loop
    v_request_key := nullif(v_item->>'request_key', '');

    begin
      v_result := public.create_story_comment_once(
        nullif(v_item->>'story_id', '')::uuid,
        nullif(v_item->>'episode_id', '')::uuid,
        nullif(v_item->>'user_id', '')::uuid,
        nullif(v_item->>'parent_id', '')::uuid,
        v_item->>'text',
        coalesce((v_item->>'is_hidden')::boolean, false),
        nullif(v_item->>'client_event_id', '')::uuid,
        nullif(v_item->>'occurred_at', '')::timestamptz
      );

      select
        to_jsonb(comments) ||
        jsonb_build_object(
          'user',
          case
            when users.id is null then null
            else jsonb_build_object(
              'id', users.id,
              'name', users.name,
              'username', users.username,
              'avatar_url', users.avatar_url,
              'role', users.role
            )
          end
        )
      into v_comment
      from public.comments comments
      left join public.users users
        on users.id = comments.user_id
      where comments.id =
        nullif(v_result->>'comment_id', '')::uuid;

      v_results := v_results || jsonb_build_array(
        v_result ||
        jsonb_build_object(
          'ok', true,
          'request_key', v_request_key,
          'comment', v_comment
        )
      );
    exception
      when others then
        v_results := v_results || jsonb_build_array(
          jsonb_build_object(
            'ok', false,
            'request_key', v_request_key,
            'client_event_id', v_item->>'client_event_id',
            'message', sqlerrm
          )
        );
    end;
  end loop;

  return jsonb_build_object(
    'items', v_results,
    'processed_at', now()
  );
end;
$$;

revoke all
on function public.create_story_comments_multi_batch_once(jsonb)
from public, anon, authenticated;

grant execute
on function public.create_story_comments_multi_batch_once(jsonb)
to service_role;
