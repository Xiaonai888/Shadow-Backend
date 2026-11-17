create or replace function public.shadow_saved_post_card_reactions(
  p_reader_ids uuid[] default '{}'::uuid[],
  p_author_ids uuid[] default '{}'::uuid[],
  p_reel_ids uuid[] default '{}'::uuid[],
  p_promotion_ids bigint[] default '{}'::bigint[]
)
returns table (
  source_type text,
  source_id text,
  like_count bigint,
  reaction_summary jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
with reaction_rows as (
  select 'reader_post'::text as kind, post_id::text as item_id, reaction_type::text as reaction_type
  from public.reader_post_reactions
  where post_id = any(p_reader_ids)
  union all
  select 'author_post'::text, post_id::text, reaction_type::text
  from public.author_page_post_reactions
  where post_id = any(p_author_ids)
  union all
  select 'promotion'::text, promotion_id::text, reaction_type::text
  from public.shadow_mall_promotion_reactions
  where promotion_id = any(p_promotion_ids)
), grouped as (
  select kind, item_id, reaction_type, count(*)::bigint as tally
  from reaction_rows
  where reaction_type in ('love','haha','wow','sad','angry','support','touched')
  group by kind, item_id, reaction_type
), ranked as (
  select kind, item_id, reaction_type, tally,
    row_number() over (
      partition by kind, item_id
      order by tally desc,
        case reaction_type
          when 'love' then 1 when 'haha' then 2 when 'wow' then 3
          when 'sad' then 4 when 'angry' then 5 when 'support' then 6
          when 'touched' then 7 else 99
        end
    ) as priority
  from grouped
), reaction_totals as (
  select kind, item_id, sum(tally)::bigint as total,
    coalesce(
      jsonb_agg(jsonb_build_object('type',reaction_type,'count',tally) order by priority)
        filter (where priority <= 3),
      '[]'::jsonb
    ) as summary
  from ranked
  group by kind, item_id
)
select kind, item_id, total, summary from reaction_totals
union all
select 'fast_video'::text, video_id::text, count(*)::bigint, '[]'::jsonb
from public.fast_video_likes
where video_id = any(p_reel_ids)
group by video_id;
$$;

revoke all on function public.shadow_saved_post_card_reactions(uuid[],uuid[],uuid[],bigint[]) from public, anon, authenticated;
grant execute on function public.shadow_saved_post_card_reactions(uuid[],uuid[],uuid[],bigint[]) to service_role;
