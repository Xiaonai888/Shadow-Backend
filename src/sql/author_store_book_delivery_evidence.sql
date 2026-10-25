begin;

create or replace function public.submit_author_store_book_delivery_evidence(
  p_hold_id uuid,
  p_author_user_id uuid,
  p_delivery_company text,
  p_tracking_number text,
  p_proof_url text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.author_store_orders%rowtype;
  v_hold public.author_store_book_payment_holds%rowtype;
  v_company text := btrim(coalesce(p_delivery_company, ''));
  v_tracking text := btrim(coalesce(p_tracking_number, ''));
  v_url text := btrim(coalesce(p_proof_url, ''));
  v_refs jsonb;
  v_now timestamptz := now();
begin
  if p_hold_id is null or p_author_user_id is null then
    raise exception 'Hold and author are required' using errcode = '22023';
  end if;

  if char_length(v_company) < 2 or char_length(v_company) > 120
     or char_length(v_tracking) < 4 or char_length(v_tracking) > 120
     or char_length(v_url) < 12 or char_length(v_url) > 1024
     or v_url !~* '^https://[^[:space:]<>"'']+$' then
    raise exception 'Delivery company, tracking number and HTTPS proof URL are required' using errcode = '22023';
  end if;

  select o.* into v_order
    from public.author_store_orders o
    join public.author_store_book_payment_holds h on h.order_id = o.id
    where h.id = p_hold_id
    for update of o;
  if not found then
    raise exception 'Book payment hold not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.author_pages a
    where a.id = v_order.author_page_id and a.user_id = p_author_user_id
  ) then
    raise exception 'Only this author may submit delivery evidence' using errcode = '42501';
  end if;

  select * into v_hold
    from public.author_store_book_payment_holds
    where id = p_hold_id
    for update;

  if v_hold.author_page_id is distinct from v_order.author_page_id
     or v_hold.status not in ('awaiting_reader', 'under_review')
     or lower(coalesce(v_order.payment_status, '')) <> 'paid'
     or lower(coalesce(v_order.order_status, v_order.status, '')) not in ('shipped', 'completed') then
    raise exception 'Paid and shipped book with active hold required' using errcode = '23514';
  end if;

  v_refs := jsonb_build_array(jsonb_build_object(
    'url', v_url,
    'submitted_at', v_now,
    'tracking_number', v_tracking,
    'delivery_company', v_company
  ));

  update public.author_store_book_payment_holds
    set status = 'under_review',
        delivery_company = v_company,
        tracking_number = v_tracking,
        proof_refs = v_refs,
        review_requested_at = coalesce(review_requested_at, v_now),
        updated_at = v_now
    where id = p_hold_id and status in ('awaiting_reader', 'under_review');

  insert into public.author_store_book_payment_hold_events (
    hold_id, action, actor_type, actor_id, reason, evidence_refs
  ) values (
    p_hold_id, 'shipment_updated', 'author', p_author_user_id::text,
    'Author submitted delivery proof and tracking information', v_refs
  );

  if v_hold.status = 'awaiting_reader' then
    insert into public.author_store_book_payment_hold_events (
      hold_id, action, actor_type, actor_id, reason, evidence_refs
    ) values (
      p_hold_id, 'review_requested', 'author', p_author_user_id::text,
      'Owner review requested for delivered physical book', v_refs
    );
  end if;

  return jsonb_build_object('ok', true, 'hold_id', p_hold_id, 'status', 'under_review');
end;
$$;

revoke all on function public.submit_author_store_book_delivery_evidence(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_author_store_book_delivery_evidence(uuid, uuid, text, text, text)
  to service_role;

commit;
