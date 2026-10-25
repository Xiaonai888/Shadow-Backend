BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.prepare_author_binance_payout_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  linked public.author_payment_methods%ROWTYPE;
  wallet public.author_binance_payout_methods%ROWTYPE;
  is_binance boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('awaiting_receipt', 'paid')
       AND (NEW.payment_method_id IS DISTINCT FROM OLD.payment_method_id
         OR NEW.payment_method_snapshot IS DISTINCT FROM OLD.payment_method_snapshot) THEN
      RAISE EXCEPTION 'RECORDED_PAYOUT_DESTINATION_IMMUTABLE';
    END IF;
  END IF;

  IF NEW.status NOT IN ('scheduled', 'missing_payment_method') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO linked
  FROM public.author_payment_methods
  WHERE id = NEW.payment_method_id;

  is_binance := COALESCE(linked.method_type = 'binance', false)
    OR COALESCE(NEW.payment_method_snapshot->>'method_type', '') = 'binance';

  IF NOT is_binance THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM public.author_pages WHERE id = NEW.author_id FOR SHARE;

  SELECT * INTO wallet
  FROM public.author_binance_payout_methods
  WHERE author_id = NEW.author_id AND user_id = NEW.user_id AND status = 'active';

  IF linked.id IS NULL
     OR linked.author_id IS DISTINCT FROM NEW.author_id
     OR linked.user_id IS DISTINCT FROM NEW.user_id
     OR linked.method_type IS DISTINCT FROM 'binance'
     OR linked.is_primary IS DISTINCT FROM true
     OR linked.status IS DISTINCT FROM 'active'
     OR linked.bank_name IS DISTINCT FROM 'Binance Auto'
     OR wallet.author_id IS NULL
     OR linked.account_name IS DISTINCT FROM wallet.account_name
     OR linked.qr_image_url IS DISTINCT FROM wallet.qr_image_url
     OR linked.binance_uid IS DISTINCT FROM wallet.binance_uid
     OR linked.binance_pay_id IS DISTINCT FROM wallet.binance_pay_id
     OR COALESCE(linked.qr_image_url, '') !~ '^https://'
     OR (NULLIF(BTRIM(COALESCE(wallet.binance_uid, '')), '') IS NULL
       AND NULLIF(BTRIM(COALESCE(wallet.binance_pay_id, '')), '') IS NULL)
     OR COALESCE(NEW.payment_method_snapshot->>'id', '') IS DISTINCT FROM NEW.payment_method_id::text
     OR COALESCE(NEW.payment_method_snapshot->>'method_type', '') IS DISTINCT FROM 'binance'
     OR COALESCE(NEW.payment_method_snapshot->>'account_name', '') IS DISTINCT FROM linked.account_name
     OR COALESCE(NEW.payment_method_snapshot->>'qr_image_url', '') IS DISTINCT FROM linked.qr_image_url THEN
    NEW.payment_method_id := NULL;
    NEW.payment_method_snapshot := '{}'::jsonb;
    NEW.status := 'missing_payment_method';
    RETURN NEW;
  END IF;

  NEW.payment_method_snapshot := NEW.payment_method_snapshot || jsonb_build_object(
    'bank_name', 'Binance Auto',
    'binance_uid', wallet.binance_uid,
    'binance_pay_id', wallet.binance_pay_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS author_binance_payout_snapshot_write_guard
ON public.author_payouts;

CREATE TRIGGER author_binance_payout_snapshot_write_guard
BEFORE INSERT OR UPDATE OF payment_method_id, payment_method_snapshot
ON public.author_payouts
FOR EACH ROW
EXECUTE FUNCTION public.prepare_author_binance_payout_snapshot();

CREATE OR REPLACE FUNCTION public.guard_author_binance_payout_transfer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  linked_type text;
  snapshot jsonb := COALESCE(NEW.payment_method_snapshot, '{}'::jsonb);
BEGIN
  SELECT method_type INTO linked_type
  FROM public.author_payment_methods
  WHERE id = NEW.payment_method_id;

  IF COALESCE(linked_type, '') <> 'binance'
     AND COALESCE(snapshot->>'method_type', '') <> 'binance' THEN
    RETURN NEW;
  END IF;

  IF NEW.payment_method_id IS NULL
     OR COALESCE(snapshot->>'id', '') IS DISTINCT FROM NEW.payment_method_id::text
     OR COALESCE(snapshot->>'method_type', '') IS DISTINCT FROM 'binance'
     OR COALESCE(snapshot->>'bank_name', '') IS DISTINCT FROM 'Binance Auto'
     OR LENGTH(BTRIM(COALESCE(snapshot->>'account_name', ''))) < 2
     OR COALESCE(snapshot->>'qr_image_url', '') !~ '^https://'
     OR (COALESCE(snapshot->>'binance_uid', '') !~ '^[A-Za-z0-9_-]{4,64}$'
       AND COALESCE(snapshot->>'binance_pay_id', '') !~ '^[A-Za-z0-9_-]{4,64}$') THEN
    RAISE EXCEPTION 'BINANCE_PAYOUT_SNAPSHOT_INCOMPLETE';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS author_binance_payout_transfer_guard
ON public.author_payouts;

CREATE TRIGGER author_binance_payout_transfer_guard
BEFORE UPDATE OF status
ON public.author_payouts
FOR EACH ROW
WHEN (NEW.status = 'awaiting_receipt' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.guard_author_binance_payout_transfer();

REVOKE ALL ON FUNCTION public.prepare_author_binance_payout_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_author_binance_payout_transfer() FROM PUBLIC;

COMMIT;
