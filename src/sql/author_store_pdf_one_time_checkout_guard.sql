CREATE OR REPLACE FUNCTION public.author_store_pdf_one_time_item_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_buyer uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.order_id IS NOT DISTINCT FROM OLD.order_id
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND lower(coalesce(NEW.product_type, '')) = lower(coalesce(OLD.product_type, ''))
       AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
      RETURN NEW;
    END IF;
  END IF;

  IF lower(coalesce(NEW.product_type, '')) <> 'pdf' THEN
    RETURN NEW;
  END IF;

  IF NEW.product_id IS NULL OR NEW.order_id IS NULL OR NEW.quantity IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'PDF_ONE_COPY_ONLY' USING ERRCODE = '23514';
  END IF;

  SELECT o.buyer_id INTO v_buyer
  FROM public.author_store_orders o
  WHERE o.id = NEW.order_id;

  IF v_buyer IS NULL THEN
    RAISE EXCEPTION 'PDF_BUYER_OR_ORDER_MISSING' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'author-store-one-pdf:' || v_buyer::text || ':' || NEW.product_id::text,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM public.author_store_reader_downloads d
    WHERE d.buyer_id = v_buyer
      AND d.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'PDF_ALREADY_PURCHASED' USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.author_store_order_items i
    JOIN public.author_store_orders o ON o.id = i.order_id
    WHERE o.buyer_id = v_buyer
      AND i.product_id = NEW.product_id
      AND lower(coalesce(i.product_type, '')) = 'pdf'
      AND (
        lower(coalesce(o.payment_status, '')) = 'paid'
        OR lower(coalesce(o.status, '')) IN ('waiting_payment', 'under_review', 'confirmed', 'preparing', 'shipped', 'completed')
      )
  ) THEN
    RAISE EXCEPTION 'PDF_PAYMENT_EXISTS_CHECK_PREVIOUS_ORDER'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.author_store_pdf_one_time_item_guard_v1()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS author_store_pdf_one_time_item_guard_v1
ON public.author_store_order_items;

CREATE TRIGGER author_store_pdf_one_time_item_guard_v1
BEFORE INSERT OR UPDATE OF product_id, order_id, product_type, quantity
ON public.author_store_order_items
FOR EACH ROW
EXECUTE FUNCTION public.author_store_pdf_one_time_item_guard_v1();

CREATE OR REPLACE FUNCTION public.author_store_pdf_preserve_first_paid_grant_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_paid boolean;
BEGIN
  IF NEW.buyer_id IS NOT DISTINCT FROM OLD.buyer_id
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    SELECT (
      lower(coalesce(o.payment_status, '')) = 'paid'
      AND lower(coalesce(o.pdf_unlock_status, '')) = 'unlocked'
      AND lower(coalesce(o.status, '')) IN ('confirmed', 'preparing', 'shipped', 'completed')
    ) INTO v_paid
    FROM public.author_store_orders o
    WHERE o.id = OLD.order_id;

    IF coalesce(v_paid, false) THEN
      NEW.order_id := OLD.order_id;
      NEW.order_number := OLD.order_number;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.author_store_pdf_preserve_first_paid_grant_v1()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS author_store_pdf_preserve_first_paid_grant_v1
ON public.author_store_reader_downloads;

CREATE TRIGGER author_store_pdf_preserve_first_paid_grant_v1
BEFORE UPDATE OF order_id, order_number
ON public.author_store_reader_downloads
FOR EACH ROW
EXECUTE FUNCTION public.author_store_pdf_preserve_first_paid_grant_v1();

SELECT
  tgname,
  tgenabled
FROM pg_catalog.pg_trigger
WHERE tgrelid IN (
  'public.author_store_order_items'::regclass,
  'public.author_store_reader_downloads'::regclass
)
AND tgname IN (
  'author_store_pdf_one_time_item_guard_v1',
  'author_store_pdf_preserve_first_paid_grant_v1'
)
ORDER BY tgname;
