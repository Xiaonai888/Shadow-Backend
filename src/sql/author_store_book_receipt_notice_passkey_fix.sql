-- NEW: src/sql/author_store_book_receipt_notice_passkey_fix.sql
-- Apply AFTER author_store_book_reader_confirm_passkey_gate.sql and
-- author_store_book_chat_notices_setup.sql.
-- Reader receipt creates a notice when receipt is recorded, NOT when money releases.
-- Owner release continues to generate its own separate notice.
-- No financial balances or release state are modified by this migration.

BEGIN;

CREATE OR REPLACE FUNCTION public.author_store_book_notice_on_hold_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_author_id uuid;
  v_notice_type text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.author_store_book_chat_links l
    WHERE l.order_id = NEW.order_id AND l.hold_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  -- Receipt is independent of payout. The new Passkey-gated workflow sets
  -- reader_confirmed_at while retaining status = under_review.
  IF NEW.reader_confirmed_at IS NOT NULL
     AND OLD.reader_confirmed_at IS NULL THEN
    v_notice_type := 'reader_received';
  ELSIF NEW.status = 'under_review'
     AND jsonb_array_length(NEW.proof_refs) > 0
     AND (OLD.status IS DISTINCT FROM NEW.status
          OR OLD.proof_refs IS DISTINCT FROM NEW.proof_refs) THEN
    v_notice_type := 'book_shipped';
  ELSIF NEW.status = 'released'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.release_source = 'reader'
     AND NEW.reader_confirmed_at IS NOT NULL THEN
    -- Legacy reader-released orders (idempotent unique notice insert).
    v_notice_type := 'reader_received';
  ELSIF NEW.status = 'released'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.release_source = 'admin' THEN
    v_notice_type := 'owner_released';
  ELSIF NEW.status = 'refunded'
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_notice_type := 'refunded';
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.buyer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.user_id INTO v_author_id
  FROM public.author_pages p
  WHERE p.id = NEW.author_page_id;

  IF v_notice_type = 'book_shipped' THEN
    INSERT INTO public.author_store_book_chat_notices (
      order_id, recipient_user_id, notice_type
    ) VALUES (NEW.order_id, NEW.buyer_id, v_notice_type)
    ON CONFLICT (order_id, recipient_user_id, notice_type) DO NOTHING;
  ELSIF v_author_id IS NOT NULL THEN
    INSERT INTO public.author_store_book_chat_notices (
      order_id, recipient_user_id, notice_type
    ) VALUES
      (NEW.order_id, NEW.buyer_id, v_notice_type),
      (NEW.order_id, v_author_id, v_notice_type)
    ON CONFLICT (order_id, recipient_user_id, notice_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_author_store_book_notice_hold_change
ON public.author_store_book_payment_holds;

CREATE TRIGGER trg_author_store_book_notice_hold_change
AFTER UPDATE OF status, proof_refs, reader_confirmed_at
ON public.author_store_book_payment_holds
FOR EACH ROW
EXECUTE FUNCTION public.author_store_book_notice_on_hold_change();

REVOKE ALL ON FUNCTION public.author_store_book_notice_on_hold_change()
FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.author_store_book_notice_on_hold_change()
TO service_role;

COMMIT;

-- Read-only verification (after running): should return two true values.
SELECT
  EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'author_store_book_payment_holds'
      AND t.tgname = 'trg_author_store_book_notice_hold_change'
      AND NOT t.tgisinternal
      AND pg_get_triggerdef(t.oid) ILIKE '%reader_confirmed_at%'
  ) AS receipt_notice_trigger_includes_confirmation,
  pg_get_functiondef('public.author_store_book_notice_on_hold_change()'::regprocedure)
    ILIKE '%OLD.reader_confirmed_at IS NULL%'
    AS receipt_notice_checks_first_confirmation;
