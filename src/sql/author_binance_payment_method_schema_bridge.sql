BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.author_payment_methods
  ADD COLUMN IF NOT EXISTS binance_uid text,
  ADD COLUMN IF NOT EXISTS binance_pay_id text;

ALTER TABLE public.author_payment_methods
  DROP CONSTRAINT IF EXISTS author_payment_methods_method_type_check;

ALTER TABLE public.author_payment_methods
  ADD CONSTRAINT author_payment_methods_method_type_check
  CHECK (method_type IN ('bank_qr', 'paypal', 'phone', 'binance'));

ALTER TABLE public.author_payment_methods
  DROP CONSTRAINT IF EXISTS author_payment_methods_binance_uid_check;

ALTER TABLE public.author_payment_methods
  ADD CONSTRAINT author_payment_methods_binance_uid_check
  CHECK (binance_uid IS NULL OR binance_uid ~ '^[A-Za-z0-9_-]{4,64}$');

ALTER TABLE public.author_payment_methods
  DROP CONSTRAINT IF EXISTS author_payment_methods_binance_pay_id_check;

ALTER TABLE public.author_payment_methods
  ADD CONSTRAINT author_payment_methods_binance_pay_id_check
  CHECK (binance_pay_id IS NULL OR binance_pay_id ~ '^[A-Za-z0-9_-]{4,64}$');

ALTER TABLE public.author_payment_methods
  DROP CONSTRAINT IF EXISTS author_payment_methods_binance_details_check;

ALTER TABLE public.author_payment_methods
  ADD CONSTRAINT author_payment_methods_binance_details_check
  CHECK (
    method_type <> 'binance'
    OR (
      coalesce(bank_name, '') = 'Binance Auto'
      AND char_length(btrim(coalesce(account_name, ''))) BETWEEN 2 AND 160
      AND coalesce(qr_image_url, '') ~ '^https://'
      AND (
        nullif(btrim(coalesce(binance_uid, '')), '') IS NOT NULL
        OR nullif(btrim(coalesce(binance_pay_id, '')), '') IS NOT NULL
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_author_payment_methods_one_binance
  ON public.author_payment_methods (author_id)
  WHERE method_type = 'binance';

COMMIT;
