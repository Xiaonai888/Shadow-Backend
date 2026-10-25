BEGIN;

SET LOCAL lock_timeout = '10s';

LOCK TABLE public.author_payment_methods IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.author_payment_method_retire_previous_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status <> 'active'
     OR NEW.method_type NOT IN ('bank_qr', 'phone', 'paypal') THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.author_pages
  WHERE id = NEW.author_id AND user_id = NEW.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTHOR_PAYMENT_METHOD_OWNER_MISMATCH';
  END IF;

  UPDATE public.author_payment_methods
  SET status = 'inactive',
      is_primary = false,
      updated_at = now()
  WHERE author_id = NEW.author_id
    AND method_type = NEW.method_type
    AND status = 'active';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS author_payment_method_single_active_insert_guard
ON public.author_payment_methods;

CREATE TRIGGER author_payment_method_single_active_insert_guard
BEFORE INSERT ON public.author_payment_methods
FOR EACH ROW
EXECUTE FUNCTION public.author_payment_method_retire_previous_on_insert();

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY author_id, method_type
           ORDER BY is_primary DESC,
                    CASE WHEN method_type = 'bank_qr'
                               AND qr_image_url ~ '^https://'
                         THEN 0 ELSE 1 END,
                    updated_at DESC NULLS LAST,
                    created_at DESC NULLS LAST,
                    id DESC
         ) AS position
  FROM public.author_payment_methods
  WHERE method_type IN ('bank_qr', 'phone', 'paypal')
    AND status = 'active'
)
UPDATE public.author_payment_methods AS method
SET status = 'inactive',
    is_primary = false,
    updated_at = now()
FROM ranked
WHERE method.id = ranked.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_author_payment_methods_one_active_legacy_type
ON public.author_payment_methods (author_id, method_type)
WHERE status = 'active'
  AND method_type IN ('bank_qr', 'phone', 'paypal');

REVOKE ALL ON FUNCTION public.author_payment_method_retire_previous_on_insert()
FROM PUBLIC;

COMMIT;
