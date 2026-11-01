BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_featured_card_audit(
  p_event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_story_id text;
  v_expected_claims bigint := 0;
  v_expected_cards bigint := 0;
  v_uncredited_claims bigint := 0;
  v_wrong_story_claims bigint := 0;
  v_grant_rows bigint := 0;
  v_granted_in_grants bigint := 0;
  v_invalid_grants bigint := 0;
  v_granted_in_balances bigint := 0;
  v_spent_in_balances bigint := 0;
  v_wrong_story_balances bigint := 0;
  v_reader_balance_mismatches bigint := 0;
  v_spent_in_redemptions bigint := 0;
  v_wrong_story_redemptions bigint := 0;
  v_ledger_consistent boolean;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Read Event ID required' USING ERRCODE = '22023';
  END IF;

  SELECT w.featured_story_id INTO v_story_id
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id AND w.audience_group = 'kh';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown Khmer Read Event' USING ERRCODE = '22023';
  END IF;

  SELECT
    pg_catalog.count(*),
    COALESCE(pg_catalog.sum(r.card_amount), 0),
    pg_catalog.count(*) FILTER (WHERE r.card_story_id IS DISTINCT FROM v_story_id)
  INTO v_expected_claims, v_expected_cards, v_wrong_story_claims
  FROM public.shadow_read_event_reward_claims AS r
  WHERE r.event_id = p_event_id
    AND r.grant_status = 'granted'
    AND r.reward_type IN ('overall_top', 'participation')
    AND r.card_amount > 0;

  SELECT pg_catalog.count(*) INTO v_uncredited_claims
  FROM public.shadow_read_event_reward_claims AS r
  LEFT JOIN public.shadow_read_event_featured_card_grants AS g ON g.claim_id = r.id
  WHERE r.event_id = p_event_id
    AND r.grant_status = 'granted'
    AND r.reward_type IN ('overall_top', 'participation')
    AND r.card_amount > 0
    AND g.claim_id IS NULL;

  SELECT
    pg_catalog.count(*),
    COALESCE(pg_catalog.sum(g.card_amount), 0),
    pg_catalog.count(*) FILTER (WHERE
      r.id IS NULL OR r.event_id IS DISTINCT FROM g.event_id
      OR r.user_id IS DISTINCT FROM g.user_id
      OR r.card_amount IS DISTINCT FROM g.card_amount
      OR r.card_story_id IS DISTINCT FROM g.story_id
      OR r.grant_status IS DISTINCT FROM 'granted'
      OR r.reward_type NOT IN ('overall_top', 'participation')
      OR g.story_id IS DISTINCT FROM v_story_id
    )
  INTO v_grant_rows, v_granted_in_grants, v_invalid_grants
  FROM public.shadow_read_event_featured_card_grants AS g
  LEFT JOIN public.shadow_read_event_reward_claims AS r ON r.id = g.claim_id
  WHERE g.event_id = p_event_id;

  SELECT
    COALESCE(pg_catalog.sum(b.granted_cards), 0),
    COALESCE(pg_catalog.sum(b.spent_cards), 0),
    pg_catalog.count(*) FILTER (WHERE b.story_id IS DISTINCT FROM v_story_id)
  INTO v_granted_in_balances, v_spent_in_balances, v_wrong_story_balances
  FROM public.shadow_read_event_featured_card_balances AS b
  WHERE b.event_id = p_event_id;

  WITH grant_totals AS (
    SELECT g.user_id, COALESCE(pg_catalog.sum(g.card_amount), 0) AS granted
    FROM public.shadow_read_event_featured_card_grants AS g
    WHERE g.event_id = p_event_id
    GROUP BY g.user_id
  )
  SELECT pg_catalog.count(*) INTO v_reader_balance_mismatches
  FROM public.shadow_read_event_featured_card_balances AS b
  LEFT JOIN grant_totals AS g ON g.user_id = b.user_id
  WHERE b.event_id = p_event_id
    AND b.granted_cards IS DISTINCT FROM COALESCE(g.granted, 0);

  SELECT
    COALESCE(pg_catalog.sum(d.cards_spent), 0),
    pg_catalog.count(*) FILTER (WHERE d.story_id IS DISTINCT FROM v_story_id)
  INTO v_spent_in_redemptions, v_wrong_story_redemptions
  FROM public.shadow_read_event_featured_card_redemptions AS d
  WHERE d.event_id = p_event_id;

  v_ledger_consistent :=
    v_invalid_grants = 0 AND v_wrong_story_claims = 0 AND
    v_wrong_story_balances = 0 AND v_wrong_story_redemptions = 0 AND
    v_reader_balance_mismatches = 0 AND
    v_granted_in_grants = v_granted_in_balances AND
    v_spent_in_balances = v_spent_in_redemptions AND
    v_spent_in_balances <= v_granted_in_balances;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'featured_story_id', v_story_id,
    'granted_card_claims', v_expected_claims,
    'expected_claim_cards', v_expected_cards,
    'uncredited_claims', v_uncredited_claims,
    'wrong_story_claims', v_wrong_story_claims,
    'grant_rows', v_grant_rows,
    'grant_cards', v_granted_in_grants,
    'invalid_grant_rows', v_invalid_grants,
    'balance_granted_cards', v_granted_in_balances,
    'balance_spent_cards', v_spent_in_balances,
    'wrong_story_balances', v_wrong_story_balances,
    'reader_balance_mismatches', v_reader_balance_mismatches,
    'redemption_spent_cards', v_spent_in_redemptions,
    'wrong_story_redemptions', v_wrong_story_redemptions,
    'ledger_consistent', v_ledger_consistent,
    'all_claims_credited', v_ledger_consistent AND
      v_uncredited_claims = 0 AND
      v_expected_cards = v_granted_in_grants AND
      v_expected_claims = v_grant_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_featured_card_audit(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_featured_card_audit(uuid)
  TO service_role;

COMMIT;
