BEGIN;

CREATE OR REPLACE FUNCTION public.shadow_read_event_settle_participation(
  p_event_id uuid,
  p_limit integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := (v_now AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_start date;
  v_enabled boolean;
  v_group text;
  v_story_id text;
  v_winners jsonb;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 30);
  v_readers uuid[] := ARRAY[]::uuid[];
  v_reader uuid;
  v_claim_id uuid;
  v_granted_id uuid;
  v_coins integer;
  v_awarded integer := 0;
  v_coins_total integer := 0;
  v_has_more boolean := false;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Read Event participation input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'shadow_read_event_overall_settlement:' || p_event_id::text, 0
    )
  );

  SELECT w.starts_on, w.is_enabled, w.audience_group, w.featured_story_id
    INTO v_start, v_enabled, v_group, v_story_id
  FROM public.shadow_read_event_weeks AS w
  WHERE w.id = p_event_id
  FOR SHARE;

  IF NOT FOUND OR v_enabled IS DISTINCT FROM true OR v_group IS DISTINCT FROM 'kh'
     OR v_story_id IS NULL OR pg_catalog.btrim(v_story_id) = '' THEN
    RAISE EXCEPTION 'Read Event is not enabled' USING ERRCODE = '22023';
  END IF;

  IF v_today < v_start + 7 THEN
    RAISE EXCEPTION 'Participation rewards require the completed event week'
      USING ERRCODE = '22023';
  END IF;

  SELECT s.winners INTO v_winners
  FROM public.shadow_read_event_overall_settlements AS s
  WHERE s.event_id = p_event_id;

  IF NOT FOUND OR v_winners IS NULL
     OR pg_catalog.jsonb_typeof(v_winners) <> 'array'
     OR pg_catalog.jsonb_array_length(v_winners) > 3 THEN
    RAISE EXCEPTION 'Overall Top 3 settlement must finish first'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(next_reader.user_id ORDER BY next_reader.user_id),
                  ARRAY[]::uuid[])
    INTO v_readers
  FROM (
    SELECT p.user_id
    FROM public.shadow_read_event_participants AS p
    JOIN public.users AS u ON u.id = p.user_id
    LEFT JOIN public.shadow_reader_classifications AS c ON c.user_id = p.user_id
    LEFT JOIN public.shadow_reader_language_snapshots AS s ON s.user_id = p.user_id
    WHERE p.event_id = p_event_id
      AND p.reader_group_snapshot = 'kh'
      AND p.joined_at < ((v_start + 7)::timestamp AT TIME ZONE 'Asia/Phnom_Penh')
      AND u.is_active IS DISTINCT FROM false
      AND (
        c.admin_group_override = 'kh'
        OR (
          c.admin_group_override IS NULL
          AND COALESCE(s.khmer_stories, 0) + COALESCE(s.international_stories, 0) >= 3
          AND COALESCE(s.khmer_stories, 0) >= COALESCE(s.international_stories, 0)
        )
      )
      AND NOT (v_winners @> pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('user_id', p.user_id)
      ))
      AND NOT EXISTS (
        SELECT 1
        FROM public.shadow_read_event_reward_claims AS r
        WHERE r.event_id = p_event_id
          AND r.user_id = p.user_id
          AND r.reward_key = 'participation'
      )
    ORDER BY p.user_id
    LIMIT v_limit
  ) AS next_reader;

  FOREACH v_reader IN ARRAY v_readers LOOP
    v_coins := 100 + pg_catalog.floor(pg_catalog.random() * 901)::integer;
    v_claim_id := NULL;

    INSERT INTO public.shadow_read_event_reward_claims (
      event_id, user_id, reward_key, reward_type,
      coin_amount, voucher_amount, card_amount, card_story_id, grant_status
    ) VALUES (
      p_event_id, v_reader, 'participation', 'participation',
      v_coins, 10, 10, v_story_id, 'pending'
    )
    ON CONFLICT (event_id, user_id, reward_key) DO NOTHING
    RETURNING id INTO v_claim_id;

    IF v_claim_id IS NULL THEN
      RAISE EXCEPTION 'Read Event participation reward conflict';
    END IF;

    INSERT INTO public.user_wallets (
      user_id, diamond_balance, gem_balance, voucher_balance
    ) VALUES (v_reader, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.user_wallets AS w
    SET gem_balance = COALESCE(w.gem_balance, 0) + v_coins,
        voucher_balance = COALESCE(w.voucher_balance, 0) + 10,
        story_card_balance = COALESCE(w.story_card_balance, 0) + 10,
        updated_at = v_now
    WHERE w.user_id = v_reader;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Read Event participation wallet is unavailable';
    END IF;

    INSERT INTO public.reader_reward_history (
      user_id, source_key, source_title,
      amount_gems, amount_vouchers, story_cards, metadata
    ) VALUES (
      v_reader, 'shadow_read_event_participation', 'Shadow Read Event Participation',
      v_coins, 10, 10,
      pg_catalog.jsonb_build_object(
        'event_id', p_event_id, 'featured_story_id', v_story_id,
        'coins', v_coins, 'vouchers', 10, 'story_cards', 10,
        'claim_id', v_claim_id
      )
    );

    v_granted_id := NULL;
    UPDATE public.shadow_read_event_reward_claims AS r
    SET grant_status = 'granted', granted_at = v_now
    WHERE r.id = v_claim_id AND r.grant_status = 'pending'
    RETURNING r.id INTO v_granted_id;

    IF v_granted_id IS DISTINCT FROM v_claim_id THEN
      RAISE EXCEPTION 'Read Event participation grant verification failed';
    END IF;

    v_awarded := v_awarded + 1;
    v_coins_total := v_coins_total + v_coins;
  END LOOP;

  SELECT EXISTS (
    SELECT 1
    FROM public.shadow_read_event_participants AS p
    JOIN public.users AS u ON u.id = p.user_id
    LEFT JOIN public.shadow_reader_classifications AS c ON c.user_id = p.user_id
    LEFT JOIN public.shadow_reader_language_snapshots AS s ON s.user_id = p.user_id
    WHERE p.event_id = p_event_id
      AND p.reader_group_snapshot = 'kh'
      AND p.joined_at < ((v_start + 7)::timestamp AT TIME ZONE 'Asia/Phnom_Penh')
      AND u.is_active IS DISTINCT FROM false
      AND (
        c.admin_group_override = 'kh'
        OR (
          c.admin_group_override IS NULL
          AND COALESCE(s.khmer_stories, 0) + COALESCE(s.international_stories, 0) >= 3
          AND COALESCE(s.khmer_stories, 0) >= COALESCE(s.international_stories, 0)
        )
      )
      AND NOT (v_winners @> pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('user_id', p.user_id)
      ))
      AND NOT EXISTS (
        SELECT 1
        FROM public.shadow_read_event_reward_claims AS r
        WHERE r.event_id = p_event_id
          AND r.user_id = p.user_id
          AND r.reward_key = 'participation'
      )
    LIMIT 1
  ) INTO v_has_more;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'awarded_count', v_awarded,
    'coins_added', v_coins_total,
    'vouchers_added', v_awarded * 10,
    'story_cards_added', v_awarded * 10,
    'has_more', v_has_more,
    'complete', NOT v_has_more
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_settle_participation(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_settle_participation(uuid, integer)
  TO service_role;

COMMIT;
