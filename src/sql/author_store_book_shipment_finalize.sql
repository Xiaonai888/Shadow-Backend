begin;

create or replace function public.finalize_author_store_book_shipment(
  p_hold_id uuid,
  p_author_user_id uuid,
  p_delivery_company text,
  p_tracking_number text,
  p_proof_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.author_store_orders%rowtype;
  v_hold public.author_store_book_payment_holds%rowtype;
  v_proof public.author_store_book_shipping_proof_uploads%rowtype;
  v_company text := btrim(coalesce(p_delivery_company, ''));
  v_tracking text := btrim(coalesce(p_tracking_number, ''));
  v_order_state text;
  v_refs jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_hold_id is null or p_author_user_id is null or p_proof_id is null then
    raise exception 'Author, book hold and proof are required' using errcode = '22023';
  end if;

  if char_length(v_company) not between 2 and 120
     or (v_tracking <> '' and char_length(v_tracking) not between 4 and 120) then
    raise exception 'Valid delivery company is required and tracking number is optional' using errcode = '22023';
  end if;

  select o.* into v_order
  from public.author_store_orders o
  join public.author_store_book_payment_holds h on h.order_id = o.id
  where h.id = p_hold_id
  for update of o;

  if not found then
    raise exception 'Book order not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.author_pages a
    where a.id = v_order.author_page_id and a.user_id = p_author_user_id
  ) then
    raise exception 'Only this author can mark this book shipped' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.author_store_book_hold_activation a
    where a.id = 1 and v_order.created_at >= a.activated_at
  ) then
    raise exception 'Legacy orders are excluded from shipment holds' using errcode = '23514';
  end if;

  select * into v_hold from public.author_store_book_payment_holds
  where id = p_hold_id for update;

  if not found or v_hold.order_id is distinct from v_order.id
     or v_hold.author_page_id is distinct from v_order.author_page_id
     or v_hold.buyer_id is distinct from v_order.buyer_id
     or v_hold.status not in ('awaiting_reader', 'under_review')
     or v_hold.held_amount_cents <= 0
     or lower(coalesce(v_order.payment_status, '')) <> 'paid' then
    raise exception 'Verified paid physical book with an active hold is required' using errcode = '23514';
  end if;

  v_order_state := lower(coalesce(nullif(v_order.order_status, ''), v_order.status, ''));

  if v_order_state not in ('under_review', 'confirmed', 'preparing', 'shipped', 'completed') then
    raise exception 'This order cannot be marked as shipped' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.author_store_order_items i
    where i.order_id = v_order.id and lower(btrim(coalesce(i.product_type, ''))) = 'book'
  ) then
    raise exception 'Physical book items are required' using errcode = '23514';
  end if;

  select * into v_proof
  from public.author_store_book_shipping_proof_uploads p
  where p.id = p_proof_id and p.hold_id = v_hold.id
    and p.author_page_id = v_order.author_page_id
    and p.uploader_user_id = p_author_user_id
  for update;

  if not found then
    raise exception 'Verified private shipping proof not found' using errcode = 'P0002';
  end if;

  if v_proof.used_at is not null then
    if v_hold.proof_refs @> jsonb_build_array(jsonb_build_object('proof_id', p_proof_id)) then
      return jsonb_build_object('ok', true, 'already_shipped', true,
        'order_id', v_order.id, 'hold_id', v_hold.id, 'status', v_hold.status);
    end if;
    raise exception 'This shipping proof was already used' using errcode = '23514';
  end if;

  if jsonb_array_length(v_hold.proof_refs) > 0 then
    raise exception 'Shipment proof already submitted for this book hold' using errcode = '23514';
  end if;

  v_refs := jsonb_build_array(jsonb_build_object(
    'proof_id', v_proof.id,
    'private', true,
    'delivery_company', v_company,
    'tracking_number', v_tracking,
    'submitted_at', v_now
  ));

  update public.author_store_orders
  set status = 'shipped', order_status = 'shipped', updated_at = v_now
  where id = v_order.id;

  update public.author_store_book_payment_holds
  set status = 'under_review', delivery_company = v_company,
      tracking_number = v_tracking, proof_refs = v_refs, updated_at = v_now
  where id = v_hold.id and status in ('awaiting_reader', 'under_review');

  if not found then
    raise exception 'Book hold changed before shipment was saved' using errcode = '40001';
  end if;

  update public.author_store_book_shipping_proof_uploads
  set used_at = v_now
  where id = v_proof.id and used_at is null;

  if not found then
    raise exception 'Shipping proof was used concurrently' using errcode = '40001';
  end if;

  insert into public.author_store_book_payment_hold_events (
    hold_id, action, actor_type, actor_id, reason, evidence_refs
  ) values (
    v_hold.id, 'shipment_updated', 'author', p_author_user_id::text,
    'Author marked verified physical book as shipped with private evidence', v_refs
  );

  return jsonb_build_object('ok', true, 'already_shipped', false,
    'order_id', v_order.id, 'hold_id', v_hold.id, 'status', 'under_review',
    'proof_id', v_proof.id);
end;
$$;

revoke all on function public.finalize_author_store_book_shipment(uuid, uuid, text, text, uuid)
from public, anon, authenticated;
grant execute on function public.finalize_author_store_book_shipment(uuid, uuid, text, text, uuid)
to service_role;

commit;
