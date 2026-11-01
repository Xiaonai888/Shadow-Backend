BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_reward_readiness_audit(
  p_event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_start date;
  v_enabled boolean;
  v_group text;
  v_now_date date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_daily_count integer := 0;
  v_overall_exists boolean := false;
  v_participants bigint := 0;
  v_granted bigint := 0;
  v_pending bigint := 0;
  v_failed bigint := 0;
  v_card_claims bigint := 0;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Read Event ID required' USING ERRCODE = '22023';
  END IF;

  SELECT w.starts_on, w.is_enabled, w.audience_group
    INTO v_start, v_enabled, v_group
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id;

  IF NOT FOUND OR v_group IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Unknown Khmer Read Event' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_daily_count
  FROM public.shadow_read_event_daily_settlements AS s
  WHERE s.event_id = p_event_id AND s.day_number BETWEEN 1 AND 7;

  SELECT EXISTS (
    SELECT 1 FROM public.shadow_read_event_overall_settlements AS s
    WHERE s.event_id = p_event_id
  ) INTO v_overall_exists;

  SELECT pg_catalog.count(*) INTO v_participants
  FROM public.shadow_read_event_participants AS p
  WHERE p.event_id = p_event_id;

  SELECT
    pg_catalog.count(*) FILTER (WHERE r.grant_status = 'granted'),
    pg_catalog.count(*) FILTER (WHERE r.grant_status = 'pending'),
    pg_catalog.count(*) FILTER (WHERE r.grant_status = 'failed'),
    pg_catalog.count(*) FILTER (
      WHERE r.grant_status = 'granted'
        AND r.reward_type IN ('overall_top', 'participation')
        AND r.card_amount > 0
    )
  INTO v_granted, v_pending, v_failed, v_card_claims
  FROM public.shadow_read_event_reward_claims AS r
  WHERE r.event_id = p_event_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'starts_on', v_start,
    'event_enabled', v_enabled,
    'week_closed', v_now_date >= v_start + 7,
    'daily_days_settled', v_daily_count,
    'overall_settled', v_overall_exists,
    'participants', v_participants,
    'granted_claims', v_granted,
    'pending_claims', v_pending,
    'failed_claims', v_failed,
    'granted_card_claims', v_card_claims
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_reward_readiness_audit(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_reward_readiness_audit(uuid)
  TO service_role;

COMMIT;
