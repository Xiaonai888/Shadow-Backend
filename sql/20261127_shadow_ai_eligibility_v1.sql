begin;
create or replace function public.shadow_ai_eligible_campaigns_v1(p_author_page_id uuid,p_active_delivery_keys text[],p_offset integer default 0)
returns jsonb language plpgsql stable set search_path = pg_catalog, public as $$
declare
  result jsonb;
begin
  if p_author_page_id is null or p_offset is null or p_offset not between 0 and 1000
    or p_active_delivery_keys is null or cardinality(p_active_delivery_keys)>32 then
    raise exception 'SHADOW_AI_INVALID_REQUEST';
  end if;
  with candidates as materialized (
    select c.id,c.title,c.close_at,c.published_at
    from public.author_preorder_campaigns c
    join public.author_pages a on a.id=c.author_page_id and a.status='active'
    join public.shadow_ai_preorder_requirements r on r.campaign_id=c.id
      and r.confirmed_by=c.owner_user_id and r.source_instruction=c.buyer_note_instruction
    where c.author_page_id=p_author_page_id and c.status='active' and c.published_at is not null
      and c.open_at<=now() and c.close_at>now()
      and c.delivery_company_keys ?| p_active_delivery_keys
    order by c.published_at desc,c.id
    offset p_offset limit 11
  ), page_rows as materialized (
    select * from candidates order by published_at desc,id limit 10
  ), snapshots as materialized (
    select p.*,public.author_preorder_stock_snapshot_multivolume(p.id) as stock
    from page_rows p
  ), eligible as (
    select s.id,s.title,s.close_at,s.published_at
    from snapshots s
    where jsonb_typeof(s.stock)='array'
      and jsonb_array_length(s.stock) between 1 and 10
      and not exists (
        select 1 from jsonb_array_elements(s.stock) b
        cross join lateral (values (b->'standard'),(b->'limited')) e(edition)
        where (edition->>'paid_reserved')::bigint+(edition->>'payment_pending_held')::bigint>(edition->>'quota')::bigint
      )
      and exists (
        select 1 from jsonb_array_elements(s.stock) b
        cross join lateral (values (b->'standard'),(b->'limited')) e(edition)
        where edition->>'enabled'='true' and (edition->>'available')::bigint>0
      )
  )
  select jsonb_build_object(
    'campaigns',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title,'close_at',close_at,'can_book',true) order by published_at desc,id) from eligible),'[]'::jsonb),
    'has_more',(select count(*)>10 from candidates),
    'next_offset',case when (select count(*)>10 from candidates) and p_offset<1000 then p_offset+10 else null end
  ) into result;
  return result;
end;
$$;
revoke all on function public.shadow_ai_eligible_campaigns_v1(uuid,text[],integer) from public, anon, authenticated;
grant execute on function public.shadow_ai_eligible_campaigns_v1(uuid,text[],integer) to service_role;
commit;
