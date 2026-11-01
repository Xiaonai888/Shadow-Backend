BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_integration_preflight(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_week record;
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_missions integer := 0;
  v_milestones integer := 0;
  v_daily_stories integer := 0;
  v_featured_valid boolean := false;
  v_tables_ready boolean;
  v_rls_ready boolean;
  v_audits_ready boolean;
  v_bridges_ready boolean;
  v_credit_ready boolean;
  v_redeem_ready boolean;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Read Event ID is required' USING ERRCODE = '22023';
  END IF;

  SELECT id, starts_on, is_enabled, audience_group, featured_story_id
  INTO v_week
  FROM public.shadow_read_event_weeks
  WHERE id = p_event_id;

  IF NOT FOUND OR v_week.audience_group IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Unknown Khmer Read Event' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_missions
  FROM public.shadow_read_event_missions WHERE event_id = p_event_id;

  SELECT pg_catalog.count(*)::integer INTO v_milestones
  FROM public.shadow_read_event_milestones WHERE event_id = p_event_id;

  SELECT pg_catalog.count(*)::integer INTO v_daily_stories
  FROM public.shadow_read_event_missions AS m
  JOIN public.stories AS s ON s.id::text = m.story_id
  WHERE m.event_id = p_event_id AND m.slot = 1 AND m.mission_type = 'daily_story'
    AND s.status = 'published' AND s.deleted_at IS NULL
    AND COALESCE(s.total_episodes, 0) >= 2
    AND COALESCE(s.is_adult, false) = false
    AND COALESCE(s.is_shadow_exclusive, false) = false
    AND COALESCE(s.admin_visibility_status, 'active') = 'active'
    AND pg_catalog.lower(COALESCE(s.access_type, 'free')) = 'free';

  SELECT EXISTS (
    SELECT 1 FROM public.stories AS s
    WHERE s.id::text = v_week.featured_story_id
      AND s.status = 'published' AND s.deleted_at IS NULL
      AND pg_catalog.lower(pg_catalog.btrim(s.story_status)) = 'completed'
      AND COALESCE(s.total_episodes, 0) >= 10
  ) INTO v_featured_valid;

  v_tables_ready :=
    pg_catalog.to_regclass('public.shadow_read_event_featured_card_balances') IS NOT NULL
    AND pg_catalog.to_regclass('public.shadow_read_event_featured_card_grants') IS NOT NULL
    AND pg_catalog.to_regclass('public.shadow_read_event_featured_card_redemptions') IS NOT NULL;

  SELECT pg_catalog.count(*) = 3 INTO v_rls_ready
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN (
    'shadow_read_event_featured_card_balances',
    'shadow_read_event_featured_card_grants',
    'shadow_read_event_featured_card_redemptions'
  ) AND c.relrowsecurity IS TRUE;

  v_audits_ready :=
    pg_catalog.to_regprocedure('public.shadow_read_event_reward_readiness_audit(uuid)') IS NOT NULL
    AND pg_catalog.to_regprocedure('public.shadow_read_event_featured_card_audit(uuid)') IS NOT NULL
    AND pg_catalog.to_regprocedure('public.shadow_read_event_card_cutover_preflight(uuid)') IS NOT NULL;

  v_bridges_ready :=
    pg_catalog.to_regprocedure('public.shadow_read_event_settle_overall_top3_legacy_v1(uuid)') IS NOT NULL
    AND pg_catalog.to_regprocedure('public.shadow_read_event_settle_participation_legacy_v1(uuid,integer)') IS NOT NULL
    AND pg_catalog.to_regprocedure('public.shadow_read_event_settle_overall_top3(uuid)') IS NOT NULL
    AND pg_catalog.to_regprocedure('public.shadow_read_event_settle_participation(uuid,integer)') IS NOT NULL;

  v_credit_ready :=
    pg_catalog.to_regprocedure('public.shadow_read_event_credit_featured_cards(uuid)') IS NOT NULL
    AND pg_catalog.to_regprocedure('public.shadow_read_event_convert_legacy_card_claim(uuid)') IS NOT NULL;

  v_redeem_ready :=
    pg_catalog.to_regprocedure('public.shadow_read_event_redeem_featured_cards(uuid,uuid,uuid)') IS NOT NULL;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'event_id', p_event_id,
    'starts_on', v_week.starts_on,
    'is_enabled', v_week.is_enabled,
    'week_closed', v_today >= v_week.starts_on + 7,
    'activation_window_open', v_today < v_week.starts_on + 7,
    'mission_count', v_missions,
    'milestone_count', v_milestones,
    'valid_daily_stories', v_daily_stories,
    'featured_story_valid', v_featured_valid,
    'card_tables_present', v_tables_ready,
    'card_rls_enabled', v_rls_ready,
    'audit_functions_present', v_audits_ready,
    'bridge_wrappers_present', v_bridges_ready,
    'card_credit_functions_present', v_credit_ready,
    'card_redeem_function_present', v_redeem_ready
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_integration_preflight(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_integration_preflight(uuid)
  TO service_role;

COMMIT;
