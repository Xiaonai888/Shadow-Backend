begin;

create or replace function public.approve_author_store_book_hold(
  p_order_id uuid,
  p_admin_id text,
  p_review_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.author_store_orders%rowtype;
  v_hold public.author_store_book_payment_holds%rowtype;
  v_admin_id text := btrim(coalesce(p_admin_id, ''));
  v_reason text := btrim(coalesce(p_review_reason, ''));
  v_approved_at timestamptz := now();
begin
  if p_order_id is null or length(v_admin_id) < 1 or length(v_admin_id) > 120 then
    raise exception 'Order and verified admin identity are required' using errcode = '22023';
  end if;

  if length(v_reason) < 15 or length(v_reason) > 2000 then
    raise exception 'An admin review reason of 15-2000 characters is required' using errcode = '22023';
  end if;

  select * into v_order
    from public.author_store_orders
    where id = p_order_id
    for update;

  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  select * into v_hold
    from public.author_store_book_payment_holds
    where order_id = v_order.id
    for update;

  if not found then
    raise exception 'Book payment hold not found' using errcode = 'P0002';
  end if;

  if v_hold.author_page_id is distinct from v_order.author_page_id then
    raise exception 'Book hold ownership mismatch' using errcode = '42501';
  end if;

  if v_hold.status = 'released' and v_hold.release_source = 'admin' then
    return jsonb_build_object(
      'ok', true,
      'already_approved', true,
      'order_id', v_order.id,
      'hold_id', v_hold.id,
      'status', v_hold.status,
      'released_at', v_hold.released_at
    );
  end if;

  if v_hold.status <> 'under_review' then
    raise exception 'Order must be under review before admin approval' using errcode = '23514';
  end if;

  if lower(coalesce(v_order.payment_status, '')) <> 'paid' then
    raise exception 'Book payment is not verified' using errcode = '23514';
  end if;

  if lower(coalesce(v_order.order_status, v_order.status, ''))
    not in ('shipped', 'completed') then
    raise exception 'Book must be shipped before admin approval' using errcode = '23514';
  end if;

  if v_hold.held_amount_cents <= 0 then
    raise exception 'Invalid frozen book payment' using errcode = '23514';
  end if;

  if coalesce(jsonb_array_length(v_hold.proof_refs), 0) = 0 then
    raise exception 'Delivery evidence is required before admin approval' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.author_store_order_items oi
    where oi.order_id = v_order.id
      and lower(btrim(coalesce(oi.product_type, ''))) = 'book'
  ) then
    raise exception 'No physical book items found' using errcode = '23514';
  end if;

  update public.author_store_book_payment_holds
     set status = 'released',
         released_at = v_approved_at,
         release_source = 'admin',
         admin_actor_id = v_admin_id,
         admin_review_reason = v_reason,
         updated_at = v_approved_at
   where id = v_hold.id and status = 'under_review';

  if not found then
    raise exception 'Book hold changed before approval' using errcode = '40001';
  end if;

  insert into public.author_store_book_payment_hold_events (
    hold_id, action, actor_type, actor_id, reason, evidence_refs
  ) values (
    v_hold.id, 'admin_approved', 'admin', v_admin_id, v_reason, v_hold.proof_refs
  ), (
    v_hold.id, 'released', 'admin', v_admin_id,
    'Physical book funds released after documented owner review', v_hold.proof_refs
  );

  return jsonb_build_object(
    'ok', true,
    'already_approved', false,
    'order_id', v_order.id,
    'hold_id', v_hold.id,
    'status', 'released',
    'released_at', v_approved_at
  );
end;
$$;

revoke all on function public.approve_author_store_book_hold(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.approve_author_store_book_hold(uuid, text, text)
  to service_role;

commit;
