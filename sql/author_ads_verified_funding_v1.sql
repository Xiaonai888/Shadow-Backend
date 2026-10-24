CREATE OR REPLACE FUNCTION public.record_author_ad_verified_funding_v1(
  p_campaign_id uuid,
  p_payment_provider text,
  p_payment_reference text,
  p_idempotency_key text,
  p_amount_cents bigint,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  recorded boolean,
  campaign_id uuid,
  ledger_id uuid,
  campaign_status text,
  funded_cents bigint,
  funding_remaining_cents bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_campaign public.author_ad_campaigns%ROWTYPE;
  v_by_key public.author_ad_budget_ledger%ROWTYPE;
  v_by_payment public.author_ad_budget_ledger%ROWTYPE;
  v_existing public.author_ad_budget_ledger%ROWTYPE;
  v_ledger_id uuid;
  v_new_funded bigint;
BEGIN
  IF p_campaign_id IS NULL
    OR p_payment_provider IS NULL OR p_payment_provider !~ '^[a-z][a-z0-9_]{1,39}$'
    OR p_payment_reference IS NULL
    OR length(btrim(p_payment_reference)) NOT BETWEEN 6 AND 160
    OR p_payment_reference !~ '^[[:graph:]]+$'
    OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9:_-]{16,180}$'
    OR p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 1000000
    OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object'
    OR octet_length(p_metadata::text) > 4096
  THEN
    RAISE EXCEPTION 'Invalid verified author ad funding details' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_campaign
  FROM public.author_ad_campaigns AS c
  WHERE c.id = p_campaign_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Author ad campaign not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT l.* INTO v_by_key
  FROM public.author_ad_budget_ledger AS l
  WHERE l.idempotency_key = p_idempotency_key;

  SELECT l.* INTO v_by_payment
  FROM public.author_ad_budget_ledger AS l
  WHERE l.entry_type = 'fund'
    AND l.payment_provider = p_payment_provider
    AND l.payment_reference = p_payment_reference;

  IF v_by_key.id IS NOT NULL AND v_by_payment.id IS NOT NULL
    AND v_by_key.id <> v_by_payment.id
  THEN
    RAISE EXCEPTION 'Conflicting author ad payment identity' USING ERRCODE = '23505';
  END IF;

  IF v_by_key.id IS NOT NULL OR v_by_payment.id IS NOT NULL THEN
    IF v_by_key.id IS NOT NULL THEN
      v_existing := v_by_key;
    ELSE
      v_existing := v_by_payment;
    END IF;

    IF v_existing.entry_type <> 'fund'
      OR v_existing.campaign_id <> p_campaign_id
      OR v_existing.owner_user_id <> v_campaign.owner_user_id
      OR v_existing.amount_cents <> p_amount_cents
      OR v_existing.payment_provider <> p_payment_provider
      OR v_existing.payment_reference <> p_payment_reference
      OR v_existing.idempotency_key <> p_idempotency_key
    THEN
      RAISE EXCEPTION 'Payment reference or idempotency key was already used' USING ERRCODE = '23505';
    END IF;

    RETURN QUERY SELECT
      false, v_campaign.id, v_existing.id, v_campaign.status,
      v_campaign.funded_cents,
      GREATEST(v_campaign.budget_cents - v_campaign.funded_cents, 0::bigint);
    RETURN;
  END IF;

  IF v_campaign.status <> 'approved'
    OR v_campaign.review_status <> 'approved'
    OR v_campaign.reviewed_at IS NULL
    OR v_campaign.currency <> 'USD'
  THEN
    RAISE EXCEPTION 'Author ad campaign is not approved for funding' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount_cents > v_campaign.budget_cents - v_campaign.funded_cents THEN
    RAISE EXCEPTION 'Verified payment exceeds the campaign funding balance' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.author_ad_budget_ledger (
    campaign_id, owner_user_id, entry_type, amount_cents, currency,
    idempotency_key, payment_provider, payment_reference, metadata
  )
  VALUES (
    v_campaign.id, v_campaign.owner_user_id, 'fund', p_amount_cents, 'USD',
    p_idempotency_key, p_payment_provider, p_payment_reference, p_metadata
  )
  RETURNING id INTO v_ledger_id;

  v_new_funded := v_campaign.funded_cents + p_amount_cents;

  UPDATE public.author_ad_campaigns AS c
  SET funded_cents = v_new_funded
  WHERE c.id = v_campaign.id
    AND c.status = 'approved'
    AND c.review_status = 'approved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Author ad campaign changed during funding' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT
    true, v_campaign.id, v_ledger_id, v_campaign.status,
    v_new_funded, GREATEST(v_campaign.budget_cents - v_new_funded, 0::bigint);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_author_ad_verified_funding_v1(
  uuid, text, text, text, bigint, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_author_ad_verified_funding_v1(
  uuid, text, text, text, bigint, jsonb
) TO service_role;
