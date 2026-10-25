BEGIN;

CREATE OR REPLACE FUNCTION public.record_author_ad_diamond_reach_v1(
  p_campaign_id uuid,
  p_viewer_user_id uuid,
  p_verified_action_id uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  recorded boolean,
  campaign_id uuid,
  event_id uuid,
  campaign_status text,
  spent_diamonds bigint,
  remaining_diamonds bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_campaign public.author_ad_campaigns%ROWTYPE;
  v_funding public.author_ad_diamond_funding%ROWTYPE;
  v_previous public.author_ad_delivery_events%ROWTYPE;
  v_event_key text;
  v_event_id uuid;
  v_now timestamptz;
  v_content_available boolean := false;
  v_spent bigint;
  v_status text;
BEGIN
  IF p_campaign_id IS NULL
    OR p_viewer_user_id IS NULL
    OR p_verified_action_id IS NULL
    OR p_metadata IS NULL
    OR jsonb_typeof(p_metadata) <> 'object'
    OR octet_length(p_metadata::text) > 4096
  THEN
    RAISE EXCEPTION 'Invalid Diamonds reach event' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_campaign
  FROM public.author_ad_campaigns AS c
  WHERE c.id = p_campaign_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Author ad campaign not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_metadata->>'content_type' IS DISTINCT FROM v_campaign.content_type
    OR p_metadata->>'measurement' IS DISTINCT FROM 'client_reported'
    OR jsonb_typeof(p_metadata->'reported_visible_ms') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_metadata->'reported_visible_ratio') IS DISTINCT FROM 'number'
  THEN
    RAISE EXCEPTION 'Invalid Diamonds reach verification metadata' USING ERRCODE = '22023';
  END IF;

  IF (p_metadata->>'reported_visible_ms')::numeric NOT BETWEEN 1000 AND 120000
    OR (p_metadata->>'reported_visible_ms')::numeric
      <> trunc((p_metadata->>'reported_visible_ms')::numeric)
    OR (p_metadata->>'reported_visible_ratio')::numeric NOT BETWEEN 0.5 AND 1
  THEN
    RAISE EXCEPTION 'Invalid Diamonds reach visibility metadata' USING ERRCODE = '22023';
  END IF;

  v_event_key := 'diamond-reach:' || p_campaign_id::text || ':' || p_viewer_user_id::text;

  SELECT e.* INTO v_previous
  FROM public.author_ad_delivery_events AS e
  WHERE e.event_key = v_event_key;

  IF FOUND THEN
    IF v_previous.campaign_id <> p_campaign_id
      OR v_previous.viewer_user_id IS DISTINCT FROM p_viewer_user_id
      OR v_previous.event_type <> 'impression'
      OR v_previous.amount_cents <> 0
      OR v_previous.placement IS DISTINCT FROM 'discover'
      OR v_previous.content_id IS DISTINCT FROM v_campaign.content_id
      OR v_previous.metadata->>'billing_unit' IS DISTINCT FROM 'diamonds'
      OR v_previous.metadata->>'charged_diamonds' IS DISTINCT FROM '1'
      OR v_previous.metadata->>'content_type' IS DISTINCT FROM v_campaign.content_type
      OR NULLIF(v_previous.metadata->>'receipt_action_id', '') IS NULL
    THEN
      RAISE EXCEPTION 'Diamonds reach key was reused with different data'
        USING ERRCODE = '23505';
    END IF;

    SELECT f.* INTO v_funding
    FROM public.author_ad_diamond_funding AS f
    WHERE f.campaign_id = p_campaign_id
      AND f.owner_user_id = v_campaign.owner_user_id;

    IF NOT FOUND
      OR v_funding.funded_diamonds IS DISTINCT FROM v_campaign.budget_cents
      OR v_funding.spent_diamonds + v_funding.refunded_diamonds > v_funding.funded_diamonds
    THEN
      RAISE EXCEPTION 'Diamonds reach funding is no longer valid'
        USING ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
      false, p_campaign_id, v_previous.id, v_campaign.status,
      COALESCE(v_funding.spent_diamonds, 0::bigint),
      GREATEST(COALESCE(v_funding.funded_diamonds, 0::bigint)
        - COALESCE(v_funding.spent_diamonds, 0::bigint)
        - COALESCE(v_funding.refunded_diamonds, 0::bigint), 0::bigint);
    RETURN;
  END IF;

  SELECT f.* INTO v_funding
  FROM public.author_ad_diamond_funding AS f
  WHERE f.campaign_id = p_campaign_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_funding.owner_user_id IS DISTINCT FROM v_campaign.owner_user_id
    OR v_funding.funded_diamonds IS DISTINCT FROM v_campaign.budget_cents
    OR v_funding.spent_diamonds + v_funding.refunded_diamonds >= v_funding.funded_diamonds
    OR v_campaign.owner_user_id = p_viewer_user_id
    OR v_campaign.status <> 'active'
    OR v_campaign.review_status <> 'approved'
    OR v_campaign.reviewed_at IS NULL
    OR v_campaign.currency <> 'USD'
    OR v_campaign.campaign_kind NOT IN ('post', 'book')
    OR v_campaign.content_type NOT IN ('post', 'story', 'product')
    OR v_campaign.content_id IS NULL
    OR v_campaign.funded_cents <> 0
    OR v_campaign.spent_cents <> 0
    OR v_campaign.refunded_cents <> 0
    OR v_campaign.start_at IS NULL
    OR v_campaign.end_at IS NULL
    OR NOT COALESCE(to_jsonb(v_campaign.placements) @> '["discover"]'::jsonb, false)
  THEN
    RAISE EXCEPTION 'Diamonds campaign is not eligible for reach'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.author_pages AS a
    WHERE a.id = v_campaign.author_page_id
      AND a.user_id = v_campaign.owner_user_id
      AND a.status = 'active'
  ) OR EXISTS (
    SELECT 1 FROM public.reader_blocked_author_pages AS b
    WHERE b.reader_user_id = p_viewer_user_id
      AND b.author_page_id = v_campaign.author_page_id
  ) OR EXISTS (
    SELECT 1 FROM public.chat_blocks AS b
    WHERE b.blocker_user_id = p_viewer_user_id
      AND b.blocked_user_id = v_campaign.owner_user_id
  ) THEN
    RAISE EXCEPTION 'Diamonds reach author is no longer eligible'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_campaign.campaign_kind = 'post' AND v_campaign.content_type = 'post' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.author_page_posts AS p
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(to_jsonb(p.image_urls)) = 'array'
          THEN to_jsonb(p.image_urls) ELSE '[]'::jsonb END
      ) AS image(url)
      WHERE p.id::text = v_campaign.content_id
        AND p.author_page_id = v_campaign.author_page_id
        AND p.user_id = v_campaign.owner_user_id
        AND p.status = 'active'
        AND btrim(image.url) <> ''
    ) INTO v_content_available;
  ELSIF v_campaign.campaign_kind = 'book' AND v_campaign.content_type = 'story' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.stories AS st
      WHERE st.id::text = v_campaign.content_id
        AND st.author_id = v_campaign.author_page_id
        AND st.status = 'published'
        AND st.deleted_at IS NULL
        AND NULLIF(btrim(st.cover_url), '') IS NOT NULL
    ) INTO v_content_available;
  ELSIF v_campaign.campaign_kind = 'book' AND v_campaign.content_type = 'product' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.author_store_products AS p
      WHERE p.id::text = v_campaign.content_id
        AND p.author_page_id = v_campaign.author_page_id
        AND p.status = 'active'
        AND p.product_type IN ('book', 'pdf')
        AND NULLIF(btrim(p.cover_url), '') IS NOT NULL
    ) INTO v_content_available;
  END IF;

  IF NOT v_content_available THEN
    RAISE EXCEPTION 'Diamonds reach content is no longer eligible'
      USING ERRCODE = 'P0001';
  END IF;

  v_now := clock_timestamp();
  IF v_now < v_campaign.start_at OR v_now >= v_campaign.end_at THEN
    RAISE EXCEPTION 'Diamonds campaign delivery window has expired'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.author_ad_delivery_events (
    campaign_id, event_type, event_key, viewer_user_id, viewer_session_hash,
    placement, content_id, amount_cents, attributed_revenue_cents,
    occurred_at, metadata
  )
  VALUES (
    p_campaign_id, 'impression', v_event_key, p_viewer_user_id, NULL,
    'discover', v_campaign.content_id, 0, 0,
    v_now, p_metadata || jsonb_build_object(
      'billing_unit', 'diamonds',
      'charged_diamonds', 1,
      'receipt_action_id', p_verified_action_id
    )
  )
  RETURNING id INTO v_event_id;

  UPDATE public.author_ad_diamond_funding AS f
  SET spent_diamonds = f.spent_diamonds + 1
  WHERE f.campaign_id = p_campaign_id
  RETURNING f.spent_diamonds INTO v_spent;

  v_status := CASE
    WHEN v_spent + v_funding.refunded_diamonds >= v_funding.funded_diamonds
      THEN 'completed'
    ELSE v_campaign.status
  END;

  IF v_status = 'completed' THEN
    UPDATE public.author_ad_campaigns AS c
    SET status = 'completed', completed_at = v_now
    WHERE c.id = p_campaign_id;
  END IF;

  RETURN QUERY SELECT
    true, p_campaign_id, v_event_id, v_status,
    v_spent, GREATEST(v_funding.funded_diamonds
      - v_funding.refunded_diamonds - v_spent, 0::bigint);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_author_ad_diamond_reach_v1(
  uuid, uuid, uuid, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_author_ad_diamond_reach_v1(
  uuid, uuid, uuid, jsonb
) TO service_role;

DO $reach_test$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.record_author_ad_diamond_reach_v1(NULL::uuid, NULL::uuid, NULL::uuid);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Unique Reach invalid-input safety check failed';
  END IF;
END;
$reach_test$;

COMMIT;
