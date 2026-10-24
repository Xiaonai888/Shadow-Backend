CREATE OR REPLACE FUNCTION public.record_author_ad_delivery_spend_v1(
  p_campaign_id uuid,
  p_event_key text,
  p_event_type text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_viewer_session_hash text DEFAULT NULL,
  p_amount_cents bigint DEFAULT 0,
  p_attributed_revenue_cents bigint DEFAULT 0,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  recorded boolean,
  campaign_id uuid,
  event_id uuid,
  campaign_status text,
  spent_cents bigint,
  remaining_cents bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_campaign public.author_ad_campaigns%ROWTYPE;
  v_previous public.author_ad_delivery_events%ROWTYPE;
  v_event_id uuid;
  v_now timestamptz := now();
  v_new_spent bigint;
  v_new_status text;
BEGIN
  IF p_campaign_id IS NULL
    OR p_event_key IS NULL
    OR p_event_key !~ '^[A-Za-z0-9:_-]{16,180}$'
    OR p_event_type NOT IN ('impression', 'click', 'reading_start', 'follow', 'unlock', 'purchase')
    OR p_amount_cents IS NULL OR p_amount_cents < 0 OR p_amount_cents > 1000000
    OR p_attributed_revenue_cents IS NULL OR p_attributed_revenue_cents < 0
    OR (p_event_type <> 'purchase' AND p_attributed_revenue_cents <> 0)
    OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object'
    OR octet_length(p_metadata::text) > 4096
    OR (p_viewer_user_id IS NULL AND p_viewer_session_hash IS NULL)
    OR (p_viewer_session_hash IS NOT NULL AND p_viewer_session_hash !~ '^[a-f0-9]{16,128}$')
  THEN
    RAISE EXCEPTION 'Invalid author ad delivery event' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_campaign
  FROM public.author_ad_campaigns AS c
  WHERE c.id = p_campaign_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Author ad campaign not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT e.* INTO v_previous
  FROM public.author_ad_delivery_events AS e
  WHERE e.event_key = p_event_key;

  IF FOUND THEN
    IF v_previous.campaign_id <> p_campaign_id
      OR v_previous.event_type <> p_event_type
      OR v_previous.amount_cents <> p_amount_cents
      OR v_previous.attributed_revenue_cents <> p_attributed_revenue_cents
      OR v_previous.viewer_user_id IS DISTINCT FROM p_viewer_user_id
      OR v_previous.viewer_session_hash IS DISTINCT FROM p_viewer_session_hash
    THEN
      RAISE EXCEPTION 'Author ad event key was reused with different data' USING ERRCODE = '23505';
    END IF;

    RETURN QUERY SELECT
      false, v_campaign.id, v_previous.id, v_campaign.status,
      v_campaign.spent_cents,
      GREATEST(v_campaign.funded_cents - v_campaign.refunded_cents - v_campaign.spent_cents, 0::bigint);
    RETURN;
  END IF;

  IF v_campaign.status <> 'active'
    OR v_campaign.review_status <> 'approved'
    OR v_campaign.reviewed_at IS NULL
    OR v_campaign.start_at IS NULL
    OR v_campaign.end_at IS NULL
    OR v_now < v_campaign.start_at
    OR v_now >= v_campaign.end_at
    OR v_campaign.funded_cents < v_campaign.budget_cents
  THEN
    RAISE EXCEPTION 'Author ad campaign is not eligible for delivery' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount_cents > v_campaign.budget_cents - v_campaign.spent_cents
    OR p_amount_cents > v_campaign.funded_cents - v_campaign.refunded_cents - v_campaign.spent_cents
  THEN
    RAISE EXCEPTION 'Author ad campaign has insufficient funded budget' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.author_ad_delivery_events (
    campaign_id, event_type, event_key, viewer_user_id, viewer_session_hash,
    placement, content_id, amount_cents, attributed_revenue_cents,
    occurred_at, metadata
  )
  VALUES (
    v_campaign.id, p_event_type, p_event_key, p_viewer_user_id, p_viewer_session_hash,
    'discover', v_campaign.content_id, p_amount_cents, p_attributed_revenue_cents,
    v_now, p_metadata
  )
  RETURNING id INTO v_event_id;

  v_new_spent := v_campaign.spent_cents + p_amount_cents;
  v_new_status := CASE
    WHEN v_new_spent >= v_campaign.budget_cents THEN 'completed'
    ELSE v_campaign.status
  END;

  IF p_amount_cents > 0 THEN
    INSERT INTO public.author_ad_budget_ledger (
      campaign_id, owner_user_id, entry_type, amount_cents, currency,
      idempotency_key, event_id, metadata
    )
    VALUES (
      v_campaign.id, v_campaign.owner_user_id, 'spend', p_amount_cents, 'USD',
      'author-ad-spend:' || p_event_key, v_event_id, p_metadata
    );

    UPDATE public.author_ad_campaigns AS c
    SET spent_cents = v_new_spent,
        status = v_new_status,
        completed_at = CASE WHEN v_new_status = 'completed' THEN v_now ELSE c.completed_at END
    WHERE c.id = v_campaign.id;
  END IF;

  RETURN QUERY SELECT
    true, v_campaign.id, v_event_id, v_new_status, v_new_spent,
    GREATEST(v_campaign.funded_cents - v_campaign.refunded_cents - v_new_spent, 0::bigint);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_author_ad_delivery_spend_v1(
  uuid, text, text, uuid, text, bigint, bigint, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_author_ad_delivery_spend_v1(
  uuid, text, text, uuid, text, bigint, bigint, jsonb
) TO service_role;
