BEGIN;

DO $migration$
BEGIN
  IF pg_catalog.to_regprocedure('public.shadow_read_event_settle_participation_legacy_v1(uuid,integer)') IS NULL THEN
    IF pg_catalog.to_regprocedure('public.shadow_read_event_settle_participation(uuid,integer)') IS NULL THEN
      RAISE EXCEPTION 'Participation settlement function is missing';
    END IF;
    ALTER FUNCTION public.shadow_read_event_settle_participation(uuid,integer)
      RENAME TO shadow_read_event_settle_participation_legacy_v1;
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.shadow_read_event_settle_participation(
  p_event_id uuid, p_limit integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_awarded integer;
  v_converted integer := 0;
  v_claim record;
  v_moved jsonb;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Read Event ID is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shadow_read_event_overall_settlement:' || p_event_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.shadow_read_event_reward_claims AS c
    WHERE c.event_id = p_event_id
      AND c.reward_type IN ('overall_top', 'participation')
      AND c.grant_status = 'granted'
      AND c.card_amount > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.shadow_read_event_featured_card_grants AS g
        WHERE g.claim_id = c.id
      )
  ) THEN
    RAISE EXCEPTION 'Historical uncredited Read Event cards require manual review before bridge payout';
  END IF;

  v_result := public.shadow_read_event_settle_participation_legacy_v1(p_event_id, p_limit);
  v_awarded := (v_result ->> 'awarded_count')::integer;

  IF v_result ->> 'ok' IS DISTINCT FROM 'true'
     OR v_result ->> 'event_id' IS DISTINCT FROM p_event_id::text
     OR v_awarded IS NULL OR v_awarded NOT BETWEEN 0 AND 30
     OR (v_result ->> 'story_cards_added') IS NULL
  THEN
    RAISE EXCEPTION 'Invalid legacy participation settlement result';
  END IF;

  FOR v_claim IN
    SELECT c.id, c.card_amount
    FROM public.shadow_read_event_reward_claims AS c
    WHERE c.event_id = p_event_id AND c.reward_type = 'participation'
      AND c.grant_status = 'granted' AND c.card_amount > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.shadow_read_event_featured_card_grants AS g
        WHERE g.claim_id = c.id
      )
    ORDER BY c.id LIMIT 31
  LOOP
    v_moved := public.shadow_read_event_convert_legacy_card_claim(v_claim.id);
    IF v_moved ->> 'ok' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Participation Featured Card conversion failed';
    END IF;
    v_converted := v_converted + 1;
  END LOOP;

  IF v_converted <> v_awarded
     OR v_converted * 10 IS DISTINCT FROM (v_result ->> 'story_cards_added')::integer THEN
    RAISE EXCEPTION 'Participation Featured Card payout mismatch';
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_settle_participation(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_settle_participation(uuid, integer)
  TO service_role;

COMMIT;
