CREATE TABLE IF NOT EXISTS public.author_ad_diamond_funding (
  campaign_id uuid PRIMARY KEY REFERENCES public.author_ad_campaigns(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL,
  funded_diamonds bigint NOT NULL CHECK (funded_diamonds BETWEEN 100 AND 1000000),
  spent_diamonds bigint NOT NULL DEFAULT 0 CHECK (spent_diamonds >= 0),
  refunded_diamonds bigint NOT NULL DEFAULT 0 CHECK (refunded_diamonds >= 0),
  wallet_balance_after bigint NOT NULL CHECK (wallet_balance_after >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT author_ad_diamond_funding_balance_check
    CHECK (spent_diamonds + refunded_diamonds <= funded_diamonds)
);

CREATE INDEX IF NOT EXISTS author_ad_diamond_funding_owner_idx
  ON public.author_ad_diamond_funding (owner_user_id, created_at DESC);

ALTER TABLE public.author_ad_diamond_funding ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.author_ad_diamond_funding FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.author_ad_diamond_funding TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_author_ad_diamonds_v1(
  p_campaign_id uuid,
  p_owner_user_id uuid
)
RETURNS TABLE (
  recorded boolean,
  campaign_id uuid,
  reserved_diamonds bigint,
  wallet_balance bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_campaign public.author_ad_campaigns%ROWTYPE;
  v_funding public.author_ad_diamond_funding%ROWTYPE;
  v_reserved bigint;
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
  FOR UPDATE;

  IF FOUND THEN
    IF v_funding.owner_user_id IS DISTINCT FROM v_campaign.owner_user_id
      OR v_funding.funded_diamonds IS DISTINCT FROM v_campaign.budget_cents
      OR v_funding.funded_diamonds NOT BETWEEN 100 AND 1000000
      OR v_funding.spent_diamonds < 0
      OR v_funding.refunded_diamonds < 0
      OR v_funding.spent_diamonds + v_funding.refunded_diamonds > v_funding.funded_diamonds
      OR v_campaign.currency <> 'USD'
      OR v_campaign.funded_cents <> 0
      OR v_campaign.spent_cents <> 0
      OR v_campaign.refunded_cents <> 0
    THEN
      RAISE EXCEPTION 'Existing Boost Diamonds funding ledger is invalid'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT w.diamond_balance::bigint INTO v_wallet_after
    FROM public.user_wallets AS w
    WHERE w.user_id = p_owner_user_id;

    IF NOT FOUND OR v_wallet_after IS NULL OR v_wallet_after < 0 THEN
      RAISE EXCEPTION 'Reader Diamonds wallet is unavailable'
        USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY SELECT
      false, v_funding.campaign_id, v_funding.funded_diamonds,
      v_wallet_after;
    RETURN;
  END IF;

  IF v_campaign.status <> 'approved'
    OR v_campaign.review_status <> 'approved'
    OR v_campaign.reviewed_at IS NULL
    OR v_campaign.currency <> 'USD'
    OR v_campaign.funded_cents <> 0
    OR v_campaign.spent_cents <> 0
    OR v_campaign.refunded_cents <> 0
    OR v_campaign.start_at IS NOT NULL
    OR v_campaign.end_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Author ad campaign is not eligible for Diamonds funding'
      USING ERRCODE = 'P0001';
  END IF;

  v_reserved := v_campaign.budget_cents;

  IF v_reserved IS NULL OR v_reserved NOT BETWEEN 100 AND 1000000 THEN
    RAISE EXCEPTION 'Invalid Diamonds budget' USING ERRCODE = '22023';
  END IF;

  UPDATE public.user_wallets AS w
  SET diamond_balance = w.diamond_balance - v_reserved
  WHERE w.user_id = p_owner_user_id
    AND w.diamond_balance >= v_reserved
  RETURNING w.diamond_balance::bigint INTO v_wallet_after;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient Reader Diamonds balance'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.author_ad_diamond_funding (
    campaign_id, owner_user_id, funded_diamonds, wallet_balance_after
  )
  VALUES (
    v_campaign.id, v_campaign.owner_user_id, v_reserved, v_wallet_after
  );

  RETURN QUERY SELECT true, v_campaign.id, v_reserved, v_wallet_after;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_author_ad_diamonds_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_author_ad_diamonds_v1(uuid, uuid)
  TO service_role;
