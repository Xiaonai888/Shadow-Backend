BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_credit_featured_cards(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_id uuid;
  v_user_id uuid;
  v_story_id text;
  v_featured_story text;
  v_amount integer;
  v_status text;
  v_type text;
  v_new_claim uuid;
  v_old_grant record;
  v_balance record;
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'Card claim ID is required' USING ERRCODE = '22023';
  END IF;

  SELECT r.event_id, r.user_id, r.card_story_id, r.card_amount,
         r.grant_status, r.reward_type, w.featured_story_id
  INTO v_event_id, v_user_id, v_story_id, v_amount,
       v_status, v_type, v_featured_story
  FROM public.shadow_read_event_reward_claims AS r
  JOIN public.shadow_read_event_weeks AS w ON w.id = r.event_id
  WHERE r.id = p_claim_id
  FOR SHARE OF r, w;

  IF NOT FOUND OR v_status IS DISTINCT FROM 'granted'
     OR v_type NOT IN ('overall_top', 'participation')
     OR v_amount IS NULL OR v_amount NOT BETWEEN 1 AND 1000
     OR v_story_id IS DISTINCT FROM v_featured_story THEN
    RAISE EXCEPTION 'Claim is not an eligible granted Featured Story Card reward'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'shadow_read_event_featured_cards:' || v_event_id::text || ':' || v_user_id::text, 0
    )
  );

  INSERT INTO public.shadow_read_event_featured_card_balances AS b
    (event_id, user_id, story_id, granted_cards, spent_cards)
  VALUES (v_event_id, v_user_id, v_story_id, 0, 0)
  ON CONFLICT (event_id, user_id) DO NOTHING;

  SELECT story_id INTO v_balance
  FROM public.shadow_read_event_featured_card_balances
  WHERE event_id = v_event_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_balance.story_id IS DISTINCT FROM v_story_id THEN
    RAISE EXCEPTION 'Featured Story Card balance belongs to another story'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.shadow_read_event_featured_card_grants
    (claim_id, event_id, user_id, story_id, card_amount)
  VALUES (p_claim_id, v_event_id, v_user_id, v_story_id, v_amount)
  ON CONFLICT (claim_id) DO NOTHING
  RETURNING claim_id INTO v_new_claim;

  IF v_new_claim IS NULL THEN
    SELECT event_id, user_id, story_id, card_amount INTO v_old_grant
    FROM public.shadow_read_event_featured_card_grants WHERE claim_id = p_claim_id;

    IF NOT FOUND OR v_old_grant.event_id IS DISTINCT FROM v_event_id
       OR v_old_grant.user_id IS DISTINCT FROM v_user_id
       OR v_old_grant.story_id IS DISTINCT FROM v_story_id
       OR v_old_grant.card_amount IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION 'Featured Story Card grant conflict';
    END IF;
  ELSE
    UPDATE public.shadow_read_event_featured_card_balances AS b
    SET granted_cards = b.granted_cards + v_amount,
        updated_at = pg_catalog.clock_timestamp()
    WHERE b.event_id = v_event_id AND b.user_id = v_user_id;
  END IF;

  SELECT granted_cards, spent_cards INTO v_balance
  FROM public.shadow_read_event_featured_card_balances
  WHERE event_id = v_event_id AND user_id = v_user_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'credited', v_new_claim IS NOT NULL,
    'event_id', v_event_id, 'user_id', v_user_id,
    'story_id', v_story_id, 'claim_id', p_claim_id,
    'cards_awarded', CASE WHEN v_new_claim IS NOT NULL THEN v_amount ELSE 0 END,
    'balance', v_balance.granted_cards - v_balance.spent_cards
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_credit_featured_cards(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_credit_featured_cards(uuid)
  TO service_role;

COMMIT;
