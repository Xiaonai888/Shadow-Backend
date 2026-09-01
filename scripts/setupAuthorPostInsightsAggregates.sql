create index if not exists author_page_post_views_viewed_at_idx
  on public.author_page_post_views (viewed_at asc);

create or replace function public.get_author_post_insights_aggregate(
  p_post_id text
)
returns table (
  views bigint,
  viewers bigint,
  follower_viewers bigint,
  non_follower_viewers bigint,
  reaction_total bigint,
  reaction_by_type jsonb,
  comments bigint,
  shares bigint,
  saves bigint,
  net_follows bigint,
  clicks bigint,
  traffic jsonb,
  views_timeline jsonb,
  demographics jsonb
)
language sql
security definer
set search_path = public
as $$
  with view_rows as (
    select
      nullif(trim(viewer_key), '') as viewer_key,
      nullif(trim(viewer_user_id), '') as viewer_user_id,
      case
        when lower(trim(coalesce(source, ''))) in (
          'feed',
          'suggested',
          'follower_feed',
          'author_page',
          'discover',
          'search',
          'share',
          'notification',
          'direct',
          'other'
        )
          then lower(trim(source))
        else 'direct'
      end as source,
      was_following,
      viewed_at
    from public.author_page_post_views
    where post_id = p_post_id
  ),
  view_totals as (
    select count(*)::bigint as views
    from view_rows
  ),
  unique_viewers as (
    select
      viewer_key,
      bool_or(was_following) as was_following
    from view_rows
    where viewer_key is not null
    group by viewer_key
  ),
  audience_totals as (
    select
      count(*)::bigint as viewers,
      count(*) filter (
        where was_following
      )::bigint as follower_viewers
    from unique_viewers
  ),
  traffic_counts as (
    select
      source,
      count(*)::bigint as views
    from view_rows
    group by source
  ),
  traffic_result as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'source', tc.source,
          'views', tc.views,
          'percentage',
            case
              when vt.views > 0
                then round(
                  (tc.views::numeric * 100) /
                  vt.views::numeric,
                  1
                )
              else 0
            end
        )
        order by tc.views desc, tc.source asc
      ),
      '[]'::jsonb
    ) as traffic
    from traffic_counts tc
    cross join view_totals vt
  ),
  timeline_counts as (
    select
      date_trunc('hour', viewed_at) as bucket_time,
      count(*)::bigint as views
    from view_rows
    group by date_trunc('hour', viewed_at)
  ),
  timeline_cumulative as (
    select
      bucket_time,
      views,
      sum(views) over (
        order by bucket_time
      )::bigint as cumulative_views
    from timeline_counts
  ),
  timeline_result as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'time',
            to_char(
              bucket_time at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
          'views', views,
          'cumulative_views', cumulative_views
        )
        order by bucket_time
      ),
      '[]'::jsonb
    ) as views_timeline
    from timeline_cumulative
  ),
  reaction_counts as (
    select
      lower(
        coalesce(
          nullif(trim(reaction_type), ''),
          'love'
        )
      ) as reaction_type,
      count(*)::bigint as reaction_count
    from public.author_page_post_reactions
    where post_id::text = p_post_id
    group by 1
  ),
  reaction_result as (
    select
      coalesce(
        sum(reaction_count),
        0
      )::bigint as reaction_total,
      coalesce(
        jsonb_object_agg(
          reaction_type,
          reaction_count
        ),
        '{}'::jsonb
      ) as reaction_by_type
    from reaction_counts
  ),
  comment_result as (
    select count(*)::bigint as comments
    from public.author_page_post_comments
    where post_id::text = p_post_id
      and is_hidden = false
      and deleted_at is null
  ),
  share_result as (
    select coalesce(
      sum(
        greatest(
          1,
          coalesce(share_count, 1)
        )
      ),
      0
    )::bigint as shares
    from public.social_echoes_v2
    where source_type = 'author_post'
      and source_id::text = p_post_id
  ),
  save_result as (
    select count(*)::bigint as saves
    from public.saved_posts
    where source_type = 'author_post'
      and source_id::text = p_post_id
  ),
  follow_result as (
    select count(*)::bigint as net_follows
    from public.author_page_follows
    where source_post_id::text = p_post_id
  ),
  click_result as (
    select count(*)::bigint as clicks
    from public.author_page_post_clicks
    where post_id = p_post_id
  ),
  registered_viewer_ids as (
    select distinct viewer_user_id
    from view_rows
    where viewer_user_id is not null
  ),
  profile_values as (
    select
      case
        when u.date_of_birth is null then null
        when date_part(
          'year',
          age(
            current_date,
            u.date_of_birth::date
          )
        ) < 18 then 'under_18'
        when date_part(
          'year',
          age(
            current_date,
            u.date_of_birth::date
          )
        ) <= 24 then '18_24'
        when date_part(
          'year',
          age(
            current_date,
            u.date_of_birth::date
          )
        ) <= 34 then '25_34'
        when date_part(
          'year',
          age(
            current_date,
            u.date_of_birth::date
          )
        ) <= 44 then '35_44'
        when date_part(
          'year',
          age(
            current_date,
            u.date_of_birth::date
          )
        ) <= 54 then '45_54'
        else '55_plus'
      end as age_key,
      case
        when lower(trim(coalesce(u.gender, ''))) in (
          'female',
          'male',
          'custom'
        )
          then lower(trim(u.gender))
        else null
      end as gender_key
    from registered_viewer_ids rv
    join public.users u
      on u.id::text = rv.viewer_user_id
  ),
  age_counts as (
    select
      age_key as key,
      count(*)::bigint as count
    from profile_values
    where age_key is not null
    group by age_key
  ),
  age_total as (
    select coalesce(
      sum(count),
      0
    )::bigint as total
    from age_counts
  ),
  age_groups as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'key', ac.key,
          'count', ac.count,
          'percentage',
            case
              when at.total > 0
                then round(
                  (ac.count::numeric * 100) /
                  at.total::numeric,
                  1
                )
              else 0
            end
        )
        order by ac.count desc, ac.key asc
      ),
      '[]'::jsonb
    ) as groups
    from age_counts ac
    cross join age_total at
  ),
  gender_counts as (
    select
      gender_key as key,
      count(*)::bigint as count
    from profile_values
    where gender_key is not null
    group by gender_key
  ),
  gender_total as (
    select coalesce(
      sum(count),
      0
    )::bigint as total
    from gender_counts
  ),
  gender_groups as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'key', gc.key,
          'count', gc.count,
          'percentage',
            case
              when gt.total > 0
                then round(
                  (gc.count::numeric * 100) /
                  gt.total::numeric,
                  1
                )
              else 0
            end
        )
        order by gc.count desc, gc.key asc
      ),
      '[]'::jsonb
    ) as groups
    from gender_counts gc
    cross join gender_total gt
  ),
  demographic_totals as (
    select
      (
        select count(*)::bigint
        from registered_viewer_ids
      ) as registered_viewers,
      at.total as age_total,
      gt.total as gender_total,
      ag.groups as age_groups,
      gg.groups as gender_groups
    from age_total at
    cross join gender_total gt
    cross join age_groups ag
    cross join gender_groups gg
  ),
  demographics_result as (
    select
      case
        when registered_viewers < 5 then
          jsonb_build_object(
            'available', false,
            'registered_viewers', registered_viewers,
            'minimum_sample', 5
          )
        else
          jsonb_build_object(
            'available',
              (
                age_total >= 5 or
                gender_total >= 5
              ),
            'registered_viewers', registered_viewers,
            'minimum_sample', 5,
            'age',
              jsonb_build_object(
                'available', age_total >= 5,
                'total', age_total,
                'groups',
                  case
                    when age_total >= 5
                      then age_groups
                    else '[]'::jsonb
                  end
              ),
            'gender',
              jsonb_build_object(
                'available', gender_total >= 5,
                'total', gender_total,
                'groups',
                  case
                    when gender_total >= 5
                      then gender_groups
                    else '[]'::jsonb
                  end
              )
          )
      end as demographics
    from demographic_totals
  )
  select
    vt.views,
    at.viewers,
    at.follower_viewers,
    greatest(
      0,
      at.viewers - at.follower_viewers
    )::bigint as non_follower_viewers,
    rr.reaction_total,
    rr.reaction_by_type,
    cr.comments,
    sr.shares,
    svr.saves,
    fr.net_follows,
    clr.clicks,
    tr.traffic,
    tlr.views_timeline,
    dr.demographics
  from view_totals vt
  cross join audience_totals at
  cross join reaction_result rr
  cross join comment_result cr
  cross join share_result sr
  cross join save_result svr
  cross join follow_result fr
  cross join click_result clr
  cross join traffic_result tr
  cross join timeline_result tlr
  cross join demographics_result dr;
$$;

revoke all on function public.get_author_post_insights_aggregate(text) from public;
grant execute on function public.get_author_post_insights_aggregate(text) to service_role;
