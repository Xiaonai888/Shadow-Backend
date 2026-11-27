begin;
create sequence if not exists public.shadow_ai_draft_revision_seq as bigint
  minvalue 1000000000000 maxvalue 9007199254740991 start with 1000000000000 no cycle;
revoke all on sequence public.shadow_ai_draft_revision_seq from public, anon, authenticated;
grant usage, select on sequence public.shadow_ai_draft_revision_seq to service_role;
create or replace function public.shadow_ai_save_booking_draft_v1(
  p_reader_user_id uuid, p_author_page_id uuid, p_campaign_id uuid,
  p_expected_revision bigint, p_draft jsonb
) returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.shadow_ai_booking_drafts%rowtype;
begin
  if p_reader_user_id is null or p_author_page_id is null or p_campaign_id is null
    or p_draft is null or jsonb_typeof(p_draft) <> 'object' or octet_length(p_draft::text) > 16000
    or (p_expected_revision is not null and p_expected_revision < 0) then
    return jsonb_build_object('ok', false, 'code', 'SHADOW_AI_DRAFT_INVALID');
  end if;
  if not exists (select 1 from public.author_preorder_campaigns c
    join public.author_pages a on a.id = c.author_page_id
    where c.id = p_campaign_id and c.author_page_id = p_author_page_id
      and a.status = 'active' and c.status = 'active' and c.published_at is not null
      and c.open_at <= v_now and c.close_at > v_now) then
    return jsonb_build_object('ok', false, 'code', 'SHADOW_AI_CAMPAIGN_UNAVAILABLE');
  end if;
  if p_expected_revision is null then
    insert into public.shadow_ai_booking_drafts as d
      (reader_user_id, author_page_id, campaign_id, draft, revision, updated_at, expires_at)
    values (p_reader_user_id, p_author_page_id, p_campaign_id, p_draft, nextval('public.shadow_ai_draft_revision_seq'), v_now, v_now + interval '24 hours')
    on conflict (reader_user_id, author_page_id, campaign_id) do update
      set draft = excluded.draft, revision = nextval('public.shadow_ai_draft_revision_seq'),
          updated_at = excluded.updated_at, expires_at = excluded.expires_at
      where d.expires_at <= v_now
    returning * into v_row;
  else
    update public.shadow_ai_booking_drafts d
      set draft = p_draft, revision = nextval('public.shadow_ai_draft_revision_seq'), updated_at = v_now,
          expires_at = v_now + interval '24 hours'
      where d.reader_user_id = p_reader_user_id and d.author_page_id = p_author_page_id
        and d.campaign_id = p_campaign_id and d.revision = p_expected_revision
        and d.expires_at > v_now
      returning * into v_row;
  end if;
  if not found then return jsonb_build_object('ok', false, 'code', 'SHADOW_AI_DRAFT_CONFLICT'); end if;
  return jsonb_build_object('ok', true, 'revision', v_row.revision, 'expires_at', v_row.expires_at);
end;
$$;
revoke all on function public.shadow_ai_save_booking_draft_v1(uuid,uuid,uuid,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.shadow_ai_save_booking_draft_v1(uuid,uuid,uuid,bigint,jsonb) to service_role;
create or replace function public.shadow_ai_cleanup_expired_drafts_v1()
returns integer language plpgsql set search_path = pg_catalog, public as $$
declare
  removed integer;
begin
  with expired as (
    select reader_user_id,author_page_id,campaign_id from public.shadow_ai_booking_drafts
    where expires_at<=now() order by expires_at limit 500 for update skip locked
  )
  delete from public.shadow_ai_booking_drafts d using expired e
  where d.reader_user_id=e.reader_user_id and d.author_page_id=e.author_page_id
    and d.campaign_id=e.campaign_id and d.expires_at<=now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.shadow_ai_cleanup_expired_drafts_v1() from public, anon, authenticated;
grant execute on function public.shadow_ai_cleanup_expired_drafts_v1() to service_role;
commit;
