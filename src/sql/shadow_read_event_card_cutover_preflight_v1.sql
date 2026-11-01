BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_card_cutover_preflight(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_week record;
  v_granted_claims bigint;
  v_uncredited bigint;
  v_grants bigint;
  v_claim_cards bigint;
  v_grant_cards bigint;
  v_invalid_story bigint;
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Read Event ID is required' USING ERRCODE = '22023';
  END IF;

  SELECT id, starts_on, audience_group, is_enabled, featured_story_id
  INTO v_week
  FROM public.shadow_read_event_weeks
  WHERE id = p_event_id;

  IF NOT FOUND OR v_week.audience_group IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Unknown Khmer Read Event' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(*),
         COALESCE(pg_catalog.sum(c.card_amount), 0),
         pg_catalog.count(*) FILTER (WHERE g.claim_id IS NULL),
         pg_catalog.count(*) FILTER (WHERE c.card_story_id IS DISTINCT FROM v_week.featured_story_id)
  INTO v_granted_claims, v_claim_cards, v_uncredited, v_invalid_story
  FROM public.shadow_read_event_reward_claims AS c
  LEFT JOIN public.shadow_read_event_featured_card_grants AS g ON g.claim_id = c.id
  WHERE c.event_id = p_event_id
    AND c.reward_type IN ('overall_top', 'participation')
    AND c.grant_status = 'granted'
    AND c.card_amount > 0;

  SELECT pg_catalog.count(*), COALESCE(pg_catalog.sum(g.card_amount), 0)
  INTO v_grants, v_grant_cards
  FROM public.shadow_read_event_featured_card_grants AS g
  WHERE g.event_id = p_event_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'starts_on', v_week.starts_on,
    'event_enabled', v_week.is_enabled,
    'week_closed', v_today >= v_week.starts_on + 7,
    'granted_card_claims', v_granted_claims,
    'uncredited_card_claims', v_uncredited,
    'granted_claim_cards', v_claim_cards,
    'featured_grant_rows', v_grants,
    'featured_granted_cards', v_grant_cards,
    'wrong_story_claims', v_invalid_story,
    'clean_event', v_granted_claims = 0 AND v_grants = 0,
    'requires_manual_reconciliation', v_uncredited > 0 OR v_invalid_story > 0,
    'safe_for_bridge_payout', v_uncredited = 0
      AND v_invalid_story = 0 AND v_claim_cards = v_grant_cards
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_card_cutover_preflight(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_card_cutover_preflight(uuid)
  TO service_role;

COMMIT;
