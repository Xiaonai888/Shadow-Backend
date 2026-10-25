CREATE OR REPLACE FUNCTION public.refund_author_ad_diamonds_v1(
  p_campaign_id uuid,
  p_owner_user_id uuid
)
RETURNS TABLE (
  refunded boolean,
  campaign_id uuid,
  refunded_diamonds bigint,
  total_refunded_diamonds bigint,
  wallet_balance bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_campaign public.author_ad_campaigns%ROWTYPE;
  v_funding public.author_ad_diamond_funding%ROWTYPE;
  v_refund bigint;
  v_wallet_after bigint;
BEGIN
  IF p_campaign_id IS NULL OR p_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Invalid campaign or account' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_campaign
  FROM public.author_ad_campaigns AS c
  WHERE c.id = p_campaign_id
  FOR UPDATE;

  IF NOT FOUND OR v_campaign.owner_user_id IS DISTINCT FROM p_owner_user_id THEN
    RAISE EXCEPTION 'Author ad campaign is not owned by this account'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT f.* INTO v_funding
  FROM public.author_ad_diamond_funding AS f
  WHERE f.campaign_id = p_campaign_id
    AND f.owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Diamond funding not found for campaign'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_campaign.status NOT IN ('cancelled', 'rejected', 'completed')
    OR v_campaign.funded_cents <> 0
    OR v_campaign.spent_cents <> 0
    OR v_campaign.refunded_cents <> 0
  THEN
    RAISE EXCEPTION 'Campaign is not eligible for a Diamonds refund'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_funding.owner_user_id IS DISTINCT FROM v_campaign.owner_user_id
    OR v_funding.funded_diamonds IS DISTINCT FROM v_campaign.budget_cents
    OR v_funding.spent_diamonds < 0
    OR v_funding.refunded_diamonds < 0
    OR v_funding.spent_diamonds + v_funding.refunded_diamonds > v_funding.funded_diamonds
  THEN
    RAISE EXCEPTION 'Campaign Diamonds funding ledger does not match budget'
      USING ERRCODE = 'P0001';
  END IF;

  v_refund := v_funding.funded_diamonds
    - v_funding.spent_diamonds
    - v_funding.refunded_diamonds;

  IF v_refund < 0 THEN
    RAISE EXCEPTION 'Invalid Diamonds funding balance'
      USING ERRCODE = '22023';
  END IF;

  IF v_refund = 0 THEN
    SELECT w.diamond_balance::bigint INTO v_wallet_after
    FROM public.user_wallets AS w
    WHERE w.user_id = p_owner_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reader Diamonds wallet not found'
        USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY SELECT
      false, p_campaign_id, 0::bigint,
      v_funding.refunded_diamonds, v_wallet_after;
    RETURN;
  END IF;

  UPDATE public.user_wallets AS w
  SET diamond_balance = w.diamond_balance + v_refund
  WHERE w.user_id = p_owner_user_id
  RETURNING w.diamond_balance::bigint INTO v_wallet_after;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reader Diamonds wallet not found'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.author_ad_diamond_funding AS f
  SET refunded_diamonds = f.refunded_diamonds + v_refund
  WHERE f.campaign_id = p_campaign_id;

  RETURN QUERY SELECT
    true, p_campaign_id, v_refund,
    v_funding.refunded_diamonds + v_refund, v_wallet_after;
END;
$function$;

REVOKE ALL ON FUNCTION public.refund_author_ad_diamonds_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_author_ad_diamonds_v1(uuid, uuid)
  TO service_role;
