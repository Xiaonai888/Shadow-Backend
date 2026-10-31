BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_claim_daily_milestones(
  p_event_id uuid,
  p_user_id uuid,
  p_day_number integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date;
  v_starts_on date;
  v_enabled boolean;
  v_audience text;
  v_current_day integer;
  v_day integer;
  v_daily_points bigint := 0;
  v_unlocked_count integer := 0;
  v_claim_ids uuid[] := ARRAY[]::uuid[];
  v_claimed_count integer := 0;
  v_coins integer := 0;
  v_coin_balance numeric;
  v_updated integer := 0;
  v_awards jsonb := '[]'::jsonb;
BEGIN
  IF p_event_id IS NULL OR p_user_id IS NULL
     OR (p_day_number IS NOT NULL AND p_day_number NOT BETWEEN 1 AND 7) THEN
    RAISE EXCEPTION 'Invalid Read Event milestone request'
      USING ERRCODE = '22023';
  END IF;

  v_today := (v_now AT TIME ZONE 'Asia/Phnom_Penh')::date;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'shadow_read_event_milestones:' || p_event_id::text || ':' || p_user_id::text, 0
    )
  );

  SELECT w.starts_on, w.is_enabled, w.audience_group
    INTO v_starts_on, v_enabled, v_audience
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id
  FOR SHARE;

  IF NOT FOUND OR v_enabled IS DISTINCT FROM true
     OR v_audience IS DISTINCT FROM 'kh' THEN
    RAISE EXCEPTION 'Read Event is not enabled' USING ERRCODE = '22023';
  END IF;

  v_current_day := v_today - v_starts_on + 1;
  IF v_current_day NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'Read Event is outside its active week'
      USING ERRCODE = '22023';
  END IF;

  v_day := COALESCE(p_day_number, v_current_day);
  IF v_day > v_current_day THEN
    RAISE EXCEPTION 'Future milestone rewards cannot be claimed'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.shadow_read_event_participants AS p
    JOIN public.users AS u ON u.id = p.user_id
    LEFT JOIN public.shadow_reader_classifications AS c ON c.user_id = u.id
    LEFT JOIN public.shadow_reader_language_snapshots AS s ON s.user_id = u.id
    WHERE p.event_id = p_event_id
      AND p.user_id = p_user_id
      AND p.reader_group_snapshot = 'kh'
      AND u.is_active IS DISTINCT FROM false
      AND (
        c.admin_group_override = 'kh'
        OR (
          c.admin_group_override IS NULL
          AND COALESCE(s.khmer_stories, 0) + COALESCE(s.international_stories, 0) >= 3
          AND COALESCE(s.khmer_stories, 0) >= COALESCE(s.international_stories, 0)
        )
      )
  ) THEN
    RAISE EXCEPTION 'Reader is not eligible or has not joined'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.sum(e.points), 0)::bigint
    INTO v_daily_points
  FROM public.shadow_read_event_score_events AS e
  WHERE e.event_id = p_event_id
    AND e.user_id = p_user_id
    AND e.day_number = v_day;

  SELECT pg_catalog.count(*)::integer
    INTO v_unlocked_count
  FROM public.shadow_read_event_milestones AS m
  WHERE m.event_id = p_event_id
    AND m.day_number = v_day
    AND m.required_points <= v_daily_points;

  IF (
    SELECT pg_catalog.count(*)
    FROM public.shadow_read_event_milestones AS m
    WHERE m.event_id = p_event_id AND m.day_number = v_day
  ) <> 5 THEN
    RAISE EXCEPTION 'Incomplete Read Event milestone plan'
      USING ERRCODE = '22023';
  END IF;

  WITH eligible AS (
    SELECT m.tier, m.coin_reward
    FROM public.shadow_read_event_milestones AS m
    WHERE m.event_id = p_event_id
      AND m.day_number = v_day
      AND m.required_points <= v_daily_points
  ),
  inserted AS (
    INSERT INTO public.shadow_read_event_reward_claims (
      event_id, user_id, reward_key, reward_type,
      day_number, tier, coin_amount, voucher_amount,
      card_amount, grant_status
    )
    SELECT p_event_id, p_user_id,
           'milestone:' || v_day::text || ':' || e.tier::text,
           'milestone', v_day, e.tier, e.coin_reward, 0, 0, 'pending'
    FROM eligible AS e
    ON CONFLICT (event_id, user_id, reward_key) DO NOTHING
    RETURNING id, coin_amount
  )
  SELECT COALESCE(pg_catalog.array_agg(i.id), ARRAY[]::uuid[]),
         COALESCE(pg_catalog.count(*), 0)::integer,
         COALESCE(pg_catalog.sum(i.coin_amount), 0)::integer
    INTO v_claim_ids, v_claimed_count, v_coins
  FROM inserted AS i;

  IF v_claimed_count > 0 THEN
    INSERT INTO public.user_wallets (
      user_id, diamond_balance, gem_balance, voucher_balance
    ) VALUES (p_user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.user_wallets AS w
    SET gem_balance = COALESCE(w.gem_balance, 0) + v_coins,
        updated_at = v_now
    WHERE w.user_id = p_user_id
    RETURNING w.gem_balance INTO v_coin_balance;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Read Event wallet is unavailable';
    END IF;

    INSERT INTO public.reader_reward_history (
      user_id, source_key, source_title,
      amount_gems, amount_vouchers, story_cards, metadata
    )
    SELECT p_user_id,
           'shadow_read_event_milestone',
           'Shadow Read Event Milestone',
           c.coin_amount, 0, 0,
           pg_catalog.jsonb_build_object(
             'event_id', p_event_id,
             'day_number', v_day,
             'tier', c.tier,
             'claim_id', c.id,
             'coins', c.coin_amount
           )
    FROM public.shadow_read_event_reward_claims AS c
    WHERE c.id = ANY(v_claim_ids);

    UPDATE public.shadow_read_event_reward_claims AS c
    SET grant_status = 'granted', granted_at = v_now
    WHERE c.id = ANY(v_claim_ids)
      AND c.grant_status = 'pending';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> v_claimed_count THEN
      RAISE EXCEPTION 'Read Event milestone grant verification failed';
    END IF;
  ELSE
    SELECT w.gem_balance INTO v_coin_balance
    FROM public.user_wallets AS w
    WHERE w.user_id = p_user_id;
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'tier', c.tier,
        'coins', c.coin_amount,
        'claim_id', c.id
      ) ORDER BY c.tier
    ), '[]'::jsonb
  ) INTO v_awards
  FROM public.shadow_read_event_reward_claims AS c
  WHERE c.id = ANY(v_claim_ids);

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'day_number', v_day,
    'daily_points', v_daily_points,
    'unlocked_milestones', v_unlocked_count,
    'new_claims', v_claimed_count,
    'coins_added', v_coins,
    'coin_balance', v_coin_balance,
    'awards', v_awards,
    'reason', CASE
      WHEN v_claimed_count > 0 THEN 'granted'
      WHEN v_unlocked_count > 0 THEN 'already_claimed'
      ELSE 'no_milestone_unlocked'
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_claim_daily_milestones(
  uuid, uuid, integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.shadow_read_event_claim_daily_milestones(
  uuid, uuid, integer
) TO service_role;

COMMIT;
