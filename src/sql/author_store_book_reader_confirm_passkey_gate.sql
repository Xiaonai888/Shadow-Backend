-- NEW migration: src/sql/author_store_book_reader_confirm_passkey_gate.sql
-- Receipt confirmation records delivery only. It NEVER releases held funds.
-- Apply after the existing author_store_book_shipping_receipt_fix.sql and
-- author_store_book_delivery_days_snapshot.sql migrations.
-- Admin fund release continues to use the existing Owner Passkey-protected API.

BEGIN;

CREATE OR REPLACE FUNCTION public.confirm_author_store_book_received(
  p_order_id uuid,
  p_buyer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order public.author_store_orders%ROWTYPE;
  v_hold public.author_store_book_payment_holds%ROWTYPE;
  v_confirmed_at timestamptz := clock_timestamp();
BEGIN
  IF p_order_id IS NULL OR p_buyer_id IS NULL THEN
    RAISE EXCEPTION 'Order and buyer are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order
    FROM public.author_store_orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.buyer_id IS DISTINCT FROM p_buyer_id THEN
    RAISE EXCEPTION 'Only this buyer may confirm receipt' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.author_store_book_hold_activation a
     WHERE a.id = 1 AND v_order.created_at >= a.activated_at
  ) THEN
    RAISE EXCEPTION 'Legacy orders are not part of the book payment hold system'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_hold
    FROM public.author_store_book_payment_holds
   WHERE order_id = v_order.id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Physical book payment hold not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_hold.buyer_id IS DISTINCT FROM p_buyer_id
     OR v_hold.author_page_id IS DISTINCT FROM v_order.author_page_id THEN
    RAISE EXCEPTION 'Book payment hold ownership mismatch' USING ERRCODE = '42501';
  END IF;

  -- A second click must never create a second receipt event or a second release.
  IF v_hold.reader_confirmed_at IS NOT NULL
     AND v_hold.status IN ('under_review', 'released') THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_confirmed', true,
      'order_id', v_order.id, 'hold_id', v_hold.id,
      'status', v_hold.status,
      'awaiting_owner', v_hold.status = 'under_review',
      'reader_confirmed_at', v_hold.reader_confirmed_at,
      'released_at', v_hold.released_at
    );
  END IF;

  IF v_hold.status NOT IN ('awaiting_reader', 'under_review')
     OR v_hold.reader_confirmed_at IS NOT NULL
     OR v_hold.release_source IS NOT NULL
     OR v_hold.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'This book payment cannot be confirmed in its current state'
      USING ERRCODE = '23514';
  END IF;

  IF lower(coalesce(v_order.payment_status, '')) <> 'paid' THEN
    RAISE EXCEPTION 'Order payment is not verified' USING ERRCODE = '23514';
  END IF;

  IF lower(coalesce(nullif(v_order.order_status, ''), v_order.status, ''))
     NOT IN ('shipped', 'completed') THEN
    RAISE EXCEPTION 'Book must be shipped before receipt confirmation'
      USING ERRCODE = '23514';
  END IF;

  IF v_hold.held_amount_cents <= 0
     OR char_length(btrim(coalesce(v_hold.delivery_company, ''))) < 2
     OR coalesce(jsonb_array_length(v_hold.proof_refs), 0) = 0 THEN
    RAISE EXCEPTION 'Delivery company and shipment proof are required'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.author_store_order_items i
     WHERE i.order_id = v_order.id
       AND lower(btrim(coalesce(i.product_type, ''))) = 'book'
  ) THEN
    RAISE EXCEPTION 'Physical book items are required' USING ERRCODE = '23514';
  END IF;

  -- Crucial: do not set status = released, released_at or release_source here.
  UPDATE public.author_store_book_payment_holds
     SET status = 'under_review',
         reader_confirmed_at = v_confirmed_at,
         review_requested_at = coalesce(review_requested_at, v_confirmed_at),
         updated_at = v_confirmed_at
   WHERE id = v_hold.id
     AND status IN ('awaiting_reader', 'under_review')
     AND reader_confirmed_at IS NULL
     AND released_at IS NULL
     AND release_source IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Book payment status changed; retry confirmation'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.author_store_book_payment_hold_events (
    hold_id, action, actor_type, actor_id, reason
  ) VALUES (
    v_hold.id, 'reader_confirmed', 'reader', p_buyer_id::text,
    'Reader confirmed receipt; funds held for Owner Passkey approval'
  );

  RETURN jsonb_build_object(
    'ok', true, 'already_confirmed', false,
    'order_id', v_order.id, 'hold_id', v_hold.id,
    'status', 'under_review',
    'awaiting_owner', true,
    'reader_confirmed_at', v_confirmed_at,
    'released_at', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_author_store_book_received(uuid, uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_author_store_book_received(uuid, uuid)
  TO service_role;

-- Preserve real delivery-day tracking when the reader confirms before release.
-- The older trigger only captured days on an immediate reader-funded release.
ALTER TABLE public.author_store_book_payment_holds
  ADD COLUMN IF NOT EXISTS actual_delivery_days integer
  CHECK (actual_delivery_days IS NULL OR actual_delivery_days >= 0);

CREATE OR REPLACE FUNCTION public.capture_author_store_book_actual_delivery_days()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_payment_at timestamptz;
  v_days numeric;
BEGIN
  IF old.actual_delivery_days IS NOT NULL THEN
    new.actual_delivery_days := old.actual_delivery_days;
    RETURN new;
  END IF;

  IF new.reader_confirmed_at IS NULL
     OR old.reader_confirmed_at IS NOT DISTINCT FROM new.reader_confirmed_at
     OR new.status NOT IN ('under_review', 'released') THEN
    RETURN new;
  END IF;

  SELECT coalesce(o.paid_at, o.confirmed_at)
    INTO v_payment_at
    FROM public.author_store_orders o
   WHERE o.id = new.order_id
     AND o.payment_status = 'paid'
     AND EXISTS (
       SELECT 1 FROM public.author_store_book_hold_activation a
        WHERE a.id = 1 AND o.created_at >= a.activated_at
     );

  IF v_payment_at IS NULL THEN
    RETURN new;
  END IF;

  v_days := greatest(
    0,
    floor(extract(epoch FROM (new.reader_confirmed_at - v_payment_at)) / 86400)
  );

  IF v_days <= 2147483647 THEN
    new.actual_delivery_days := v_days::integer;
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_author_store_book_actual_delivery_days
  ON public.author_store_book_payment_holds;
CREATE TRIGGER trg_author_store_book_actual_delivery_days
BEFORE UPDATE OF status, reader_confirmed_at
ON public.author_store_book_payment_holds
FOR EACH ROW
EXECUTE FUNCTION public.capture_author_store_book_actual_delivery_days();

REVOKE ALL ON FUNCTION public.capture_author_store_book_actual_delivery_days()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_author_store_book_actual_delivery_days()
  TO service_role;

COMMIT;

-- Read-only verification: the updated receipt function should not assign
-- release_source or released_at. Does not execute a real money transaction.
SELECT
  p.proname AS function_name,
  pg_get_functiondef(p.oid) LIKE '%awaiting_owner%' AS returns_pending_owner,
  pg_get_functiondef(p.oid) NOT LIKE '%SET status = ''released''%' AS no_auto_release_statement
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_author_store_book_received';
