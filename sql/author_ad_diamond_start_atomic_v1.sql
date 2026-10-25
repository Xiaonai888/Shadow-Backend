BEGIN;

CREATE OR REPLACE FUNCTION public.start_author_ad_campaign_with_diamonds_v1(
  p_campaign_id uuid,
  p_owner_user_id uuid
)
RETURNS TABLE (
  changed boolean,
  campaign_id uuid,
  campaign_status text,
  starts_at timestamptz,
  ends_at timestamptz,
  funded_cents bigint,
  spent_cents bigint,
  available_cents bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_campaign public.author_ad_campaigns%ROWTYPE;
BEGIN
  IF p_campaign_id IS NULL OR p_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Boost campaign or account' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_campaign
  FROM public.author_ad_campaigns AS c
  WHERE c.id = p_campaign_id
    AND c.owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Boost campaign not found for this account' USING ERRCODE = 'P0002';
  END IF;

  IF v_campaign.status = 'approved' THEN
    IF v_campaign.funded_cents = 0
      AND v_campaign.spent_cents = 0
      AND v_campaign.refunded_cents = 0
    THEN
      PERFORM public.reserve_author_ad_diamonds_v1(
        p_campaign_id,
        p_owner_user_id
      );
    END IF;
  ELSIF v_campaign.status <> 'active' THEN
    RAISE EXCEPTION 'Boost campaign cannot be started' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    t.changed,
    t.campaign_id,
    t.campaign_status,
    t.starts_at,
    t.ends_at,
    t.funded_cents,
    t.spent_cents,
    t.available_cents
  FROM public.transition_author_ad_campaign_v1(p_campaign_id, 'start') AS t;
END;
$function$;

REVOKE ALL ON FUNCTION public.start_author_ad_campaign_with_diamonds_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_author_ad_campaign_with_diamonds_v1(uuid, uuid)
  TO service_role;

COMMIT;
