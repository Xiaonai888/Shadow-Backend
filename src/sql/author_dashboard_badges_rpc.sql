create or replace function public.get_author_dashboard_badges(
  p_user_id uuid
)
returns table (
  story_unread_count bigint,
  mail_unread_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with author_page as (
    select id
    from public.author_pages
    where user_id = p_user_id
      and status = 'active'
    limit 1
  ),
  ranked_story_notifications as (
    select
      is_read,
      created_at,
      row_number() over (
        order by created_at desc
      ) as row_number
    from public.author_story_notifications
    where author_id = (
      select id
      from author_page
    )
  )
  select
    (
      select count(*)
      from ranked_story_notifications
      where is_read = false
        and (
          row_number <= 30
          or created_at >=
            now() - interval '30 days'
        )
    )::bigint as story_unread_count,
    (
      select count(*)
      from public.reader_mails
      where user_id = p_user_id
        and is_read = false
        and deleted_at is null
        and created_at >=
          now() - interval '365 days'
        and (
          reference_id is null
          or reference_id not like
            'daily_checkin_reminder_%'
          or created_at >=
            now() - interval '7 days'
        )
    )::bigint as mail_unread_count;
$$;

revoke all on function
  public.get_author_dashboard_badges(uuid)
from public;

grant execute on function
  public.get_author_dashboard_badges(uuid)
to service_role;
