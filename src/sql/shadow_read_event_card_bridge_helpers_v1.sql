BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_convert_legacy_card_claim(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claim record;
  v_credit jsonb;
  v_wallet_rows integer;
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'Featured Card claim ID required' USING ERRCODE = '22023';
  END IF;

  SELECT c.id, c.event_id, c.user_id, c.card_amount
  INTO v_claim
  FROM public.shadow_read_event_reward_claims AS c
  WHERE c.id = p_claim_id
    AND c.grant_status = 'granted'
    AND c.reward_type IN ('overall_top', 'participation')
    AND c.card_amount > 0
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not an eligible granted Featured Card claim' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.shadow_read_event_featured_card_grants AS g
    WHERE g.claim_id = p_claim_id
  ) THEN
    RAISE EXCEPTION 'Featured Card claim was already converted' USING ERRCODE = '22023';
  END IF;

  v_credit := public.shadow_read_event_credit_featured_cards(p_claim_id);
  IF v_credit ->> 'credited' IS DISTINCT FROM 'true'
    OR v_credit ->> 'claim_id' IS DISTINCT FROM p_claim_id::text
    OR (v_credit ->> 'cards_awarded')::integer IS DISTINCT FROM v_claim.card_amount
  THEN
    RAISE EXCEPTION 'Featured Card claim credit was not verified';
  END IF;

  UPDATE public.user_wallets AS w
     SET story_card_balance = COALESCE(w.story_card_balance, 0) - v_claim.card_amount,
         updated_at = pg_catalog.clock_timestamp()
   WHERE w.user_id = v_claim.user_id
     AND COALESCE(w.story_card_balance, 0) >= v_claim.card_amount;

  GET DIAGNOSTICS v_wallet_rows = ROW_COUNT;
  IF v_wallet_rows <> 1 THEN
    RAISE EXCEPTION 'Legacy card balance could not be reversed in same transaction';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'claim_id', p_claim_id,
    'event_id', v_claim.event_id,
    'user_id', v_claim.user_id,
    'cards_moved', v_claim.card_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_convert_legacy_card_claim(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_convert_legacy_card_claim(uuid)
  TO service_role;

COMMIT;
