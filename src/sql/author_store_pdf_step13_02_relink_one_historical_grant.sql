BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.author_store_pdf_preserve_first_paid_grant_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_paid boolean;
  v_first_paid_id uuid;
  v_first_paid_public_id text;
BEGIN
  IF NEW.buyer_id IS NOT DISTINCT FROM OLD.buyer_id
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    SELECT (
      lower(coalesce(o.payment_status, '')) = 'paid'
      AND lower(coalesce(o.pdf_unlock_status, '')) = 'unlocked'
      AND lower(coalesce(o.status, '')) IN ('confirmed', 'preparing', 'shipped', 'completed')
    ) INTO v_old_paid
    FROM public.author_store_orders o
    WHERE o.id = OLD.order_id AND o.buyer_id = OLD.buyer_id;

    IF coalesce(v_old_paid, false) THEN
      SELECT o.id, o.order_id
      INTO v_first_paid_id, v_first_paid_public_id
      FROM public.author_store_orders o
      JOIN public.author_store_order_items i ON i.order_id = o.id
      WHERE o.buyer_id = OLD.buyer_id
        AND i.product_id = OLD.product_id
        AND lower(coalesce(i.product_type, '')) = 'pdf'
        AND lower(coalesce(o.payment_status, '')) = 'paid'
        AND lower(coalesce(o.pdf_unlock_status, '')) = 'unlocked'
        AND lower(coalesce(o.status, '')) IN ('confirmed', 'preparing', 'shipped', 'completed')
      ORDER BY coalesce(o.paid_at, o.created_at), o.created_at, o.id
      LIMIT 1;

      IF v_first_paid_id IS NULL OR NEW.order_id IS DISTINCT FROM v_first_paid_id THEN
        NEW.order_id := OLD.order_id;
        NEW.order_number := OLD.order_number;
      ELSE
        NEW.order_number := v_first_paid_public_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.author_store_pdf_preserve_first_paid_grant_v1()
FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_buyer uuid := '9f318d3a-364f-4c1c-a20e-4bf6d1e42b58';
  v_product uuid := '163e76a0-5296-4db3-a1e5-a14036696849';
  v_first public.author_store_orders%ROWTYPE;
  v_second public.author_store_orders%ROWTYPE;
  v_paid_count integer;
  v_grant_count integer;
  v_grant_link text;
  v_guard_count integer;
  v_changed integer;
  v_after_link uuid;
BEGIN
  PERFORM 1 FROM public.author_store_orders o
  WHERE o.buyer_id = v_buyer
    AND o.order_id IN ('AMWQMAM75A7BD6EAC', 'AMWQMWJJ4D729DE5E')
  FOR UPDATE;

  SELECT * INTO STRICT v_first FROM public.author_store_orders
  WHERE buyer_id = v_buyer AND order_id = 'AMWQMAM75A7BD6EAC';

  SELECT * INTO STRICT v_second FROM public.author_store_orders
  WHERE buyer_id = v_buyer AND order_id = 'AMWQMWJJ4D729DE5E';

  IF v_first.id = v_second.id
     OR v_first.payment_status IS DISTINCT FROM 'paid'
     OR v_second.payment_status IS DISTINCT FROM 'paid'
     OR v_first.pdf_unlock_status IS DISTINCT FROM 'unlocked'
     OR v_second.pdf_unlock_status IS DISTINCT FROM 'unlocked'
     OR v_first.status NOT IN ('confirmed', 'preparing', 'shipped', 'completed')
     OR v_second.status NOT IN ('confirmed', 'preparing', 'shipped', 'completed')
     OR v_first.paid_at IS NULL OR v_second.paid_at IS NULL
     OR v_first.paid_at >= v_second.paid_at
     OR v_first.total_usd IS DISTINCT FROM 1.25
     OR v_second.total_usd IS DISTINCT FROM 1.25
     OR v_first.aba_transaction_id::text IS DISTINCT FROM '179527823620533'
     OR v_second.aba_transaction_id::text IS DISTINCT FROM '179527924341403'
  THEN
    RAISE EXCEPTION 'STOP: PAYMENT_PROOF_MISMATCH';
  END IF;

  IF (SELECT COUNT(*) FROM public.author_store_order_items WHERE order_id = v_first.id) <> 1
     OR (SELECT COUNT(*) FROM public.author_store_order_items WHERE order_id = v_second.id) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.author_store_order_items
       WHERE order_id = v_first.id AND product_id = v_product
         AND lower(coalesce(product_type, '')) = 'pdf' AND quantity = 1
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.author_store_order_items
       WHERE order_id = v_second.id AND product_id = v_product
         AND lower(coalesce(product_type, '')) = 'pdf' AND quantity = 1
     )
  THEN
    RAISE EXCEPTION 'STOP: PDF_ITEMS_MISMATCH';
  END IF;

  SELECT COUNT(DISTINCT o.id) INTO v_paid_count
  FROM public.author_store_orders o
  JOIN public.author_store_order_items i ON i.order_id = o.id
  WHERE o.buyer_id = v_buyer AND i.product_id = v_product
    AND lower(coalesce(i.product_type, '')) = 'pdf'
    AND lower(coalesce(o.payment_status, '')) = 'paid';

  IF v_paid_count <> 2 THEN
    RAISE EXCEPTION 'STOP: UNEXPECTED_NUMBER_OF_PAID_ORDERS: %', v_paid_count;
  END IF;

  SELECT COUNT(*), MIN(d.order_id::text) INTO v_grant_count, v_grant_link
  FROM public.author_store_reader_downloads d
  WHERE d.buyer_id = v_buyer AND d.product_id = v_product;

  IF v_grant_count <> 1 OR v_grant_link IS DISTINCT FROM v_second.id::text THEN
    RAISE EXCEPTION 'STOP: CURRENT_GRANT_IS_NOT_SECOND_PAID_ORDER';
  END IF;

  SELECT COUNT(*) INTO v_guard_count FROM pg_catalog.pg_trigger tr
  WHERE tr.tgrelid = 'public.author_store_reader_downloads'::regclass
    AND tr.tgname = 'author_store_pdf_preserve_first_paid_grant_v1'
    AND tr.tgenabled IN ('O', 'A') AND NOT tr.tgisinternal;
  IF v_guard_count <> 1 THEN
    RAISE EXCEPTION 'STOP: HISTORICAL_GRANT_GUARD_DISABLED';
  END IF;

  UPDATE public.author_store_reader_downloads d
  SET order_id = v_first.id, order_number = v_first.order_id
  WHERE d.buyer_id = v_buyer AND d.product_id = v_product
    AND d.order_id = v_second.id;

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'STOP: GRANT_ROW_UPDATE_COUNT: %', v_changed;
  END IF;

  SELECT d.order_id INTO v_after_link FROM public.author_store_reader_downloads d
  WHERE d.buyer_id = v_buyer AND d.product_id = v_product;
  IF v_after_link IS DISTINCT FROM v_first.id THEN
    RAISE EXCEPTION 'STOP: TRIGGER_BLOCKED_FIRST_PAID_ORDER_CORRECTION';
  END IF;

  RAISE NOTICE 'PDF_GRANT_CORRECTED_TO_FIRST_PAID_ORDER: %', v_first.order_id;
END;
$$;

COMMIT;
