BEGIN;

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.author_binance_payout_methods') IS NULL
     OR to_regclass('public.author_payment_methods') IS NULL THEN
    RAISE EXCEPTION 'Author payout tables must be installed first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'author_payment_methods'
      AND column_name = 'binance_uid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'author_payment_methods'
      AND column_name = 'binance_pay_id'
  ) THEN
    RAISE EXCEPTION 'Run author_binance_payment_method_schema_bridge.sql first';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_author_payment_methods_one_binance
  ON public.author_payment_methods (author_id)
  WHERE method_type = 'binance';

CREATE OR REPLACE FUNCTION public.sync_author_binance_payout_method()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1
  FROM public.author_pages
  WHERE id = NEW.author_id AND user_id = NEW.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Author payout owner mismatch';
  END IF;

  IF NEW.status = 'active' THEN
    UPDATE public.author_payment_methods
    SET is_primary = false, updated_at = now()
    WHERE author_id = NEW.author_id AND is_primary = true;

    INSERT INTO public.author_payment_methods (
      author_id, user_id, method_type, display_name,
      account_name, bank_name, qr_image_url,
      binance_uid, binance_pay_id,
      status, is_primary, updated_at
    ) VALUES (
      NEW.author_id, NEW.user_id, 'binance', 'Binance',
      NEW.account_name, 'Binance Auto', NEW.qr_image_url,
      NEW.binance_uid, NEW.binance_pay_id,
      'active', true, now()
    )
    ON CONFLICT (author_id) WHERE method_type = 'binance'
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      display_name = EXCLUDED.display_name,
      account_name = EXCLUDED.account_name,
      bank_name = EXCLUDED.bank_name,
      qr_image_url = EXCLUDED.qr_image_url,
      binance_uid = EXCLUDED.binance_uid,
      binance_pay_id = EXCLUDED.binance_pay_id,
      status = 'active',
      is_primary = true,
      updated_at = now();
  ELSE
    UPDATE public.author_payment_methods
    SET status = 'inactive', is_primary = false, updated_at = now()
    WHERE author_id = NEW.author_id AND method_type = 'binance';

    UPDATE public.author_payment_methods
    SET is_primary = true, updated_at = now()
    WHERE id = (
      SELECT id FROM public.author_payment_methods
      WHERE author_id = NEW.author_id
        AND status = 'active'
        AND method_type <> 'binance'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.author_payment_methods
      WHERE author_id = NEW.author_id
        AND status = 'active'
        AND is_primary = true
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_author_binance_payout_method_trigger
  ON public.author_binance_payout_methods;

CREATE TRIGGER sync_author_binance_payout_method_trigger
AFTER INSERT OR UPDATE OF account_name, binance_uid, binance_pay_id, qr_image_url, status
ON public.author_binance_payout_methods
FOR EACH ROW
EXECUTE FUNCTION public.sync_author_binance_payout_method();

DO $$
DECLARE
  entry record;
BEGIN
  FOR entry IN
    SELECT author_id, user_id, account_name, binance_uid,
           binance_pay_id, qr_image_url, status
    FROM public.author_binance_payout_methods
    ORDER BY author_id
  LOOP
    PERFORM 1 FROM public.author_pages
    WHERE id = entry.author_id AND user_id = entry.user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Author payout owner mismatch during migration';
    END IF;

    INSERT INTO public.author_payment_methods (
      author_id, user_id, method_type, display_name,
      account_name, bank_name, qr_image_url,
      binance_uid, binance_pay_id,
      status, is_primary, updated_at
    ) VALUES (
      entry.author_id, entry.user_id, 'binance', 'Binance',
      entry.account_name, 'Binance Auto', entry.qr_image_url,
      entry.binance_uid, entry.binance_pay_id,
      CASE WHEN entry.status = 'active' THEN 'active' ELSE 'inactive' END,
      entry.status = 'active' AND NOT EXISTS (
        SELECT 1 FROM public.author_payment_methods
        WHERE author_id = entry.author_id
          AND is_primary = true AND status = 'active'
      ),
      now()
    )
    ON CONFLICT (author_id) WHERE method_type = 'binance'
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      display_name = EXCLUDED.display_name,
      account_name = EXCLUDED.account_name,
      bank_name = EXCLUDED.bank_name,
      qr_image_url = EXCLUDED.qr_image_url,
      binance_uid = EXCLUDED.binance_uid,
      binance_pay_id = EXCLUDED.binance_pay_id,
      status = EXCLUDED.status,
      is_primary = CASE WHEN EXCLUDED.status = 'inactive'
        THEN false ELSE author_payment_methods.is_primary END,
      updated_at = now();
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_author_binance_payout_method() FROM PUBLIC;

COMMIT;
