BEGIN;

CREATE TABLE IF NOT EXISTS public.shadow_read_event_overall_settlements (
  event_id uuid PRIMARY KEY REFERENCES public.shadow_read_event_weeks(id) ON DELETE RESTRICT,
  winners jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (pg_catalog.jsonb_typeof(winners) = 'array'
      AND pg_catalog.jsonb_array_length(winners) <= 3),
  awarded_count smallint NOT NULL DEFAULT 0 CHECK (awarded_count BETWEEN 0 AND 3),
  settled_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.shadow_read_event_overall_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shadow_read_event_overall_settlements FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.shadow_read_event_overall_settlements TO service_role;

CREATE OR REPLACE FUNCTION public.shadow_read_event_settle_overall_top3(
  p_event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Phnom_Penh')::date;
  v_start date;
  v_enabled boolean;
  v_group text;
  v_story_id text;
  v_winners jsonb := '[]'::jsonb;
  v_existing record;
  v_winner jsonb;
  v_reader uuid;
  v_rank integer;
  v_cards integer;
  v_coins integer;
  v_vouchers integer;
  v_claim_id uuid;
  v_paid integer := 0;
  v_coins_total integer := 0;
  v_vouchers_total integer := 0;
  v_cards_total integer := 0;
  v_written integer := 0;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Read Event overall payout input' USING ERRCODE = '22023';
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
    RAISE EXCEPTION 'Read Event is not enabled or lacks its Featured Story'
      USING ERRCODE = '22023';
  END IF;

  IF v_today < v_start + 7 THEN
    RAISE EXCEPTION 'Overall Top 3 cannot settle before the full week closes'
      USING ERRCODE = '22023';
  END IF;

  SELECT s.winners, s.awarded_count, s.settled_at
    INTO v_existing
  FROM public.shadow_read_event_overall_settlements AS s
  WHERE s.event_id = p_event_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'settled', true, 'already_settled', true,
      'event_id', p_event_id, 'awarded_count', v_existing.awarded_count,
      'winners', v_existing.winners, 'settled_at', v_existing.settled_at
    );
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM public.shadow_read_event_daily_settlements AS s
    WHERE s.event_id = p_event_id AND s.day_number BETWEEN 1 AND 7
  ) <> 7 THEN
    RAISE EXCEPTION 'All seven Daily Top 3 settlements must finish first'
      USING ERRCODE = '22023';
  END IF;

  WITH score_totals AS MATERIALIZED (
    SELECT e.user_id,
           pg_catalog.sum(e.points)::bigint AS points,
           pg_catalog.max(e.created_at) AS last_score_at
    FROM public.shadow_read_event_score_events AS e
    JOIN public.shadow_read_event_participants AS p
      ON p.event_id = e.event_id AND p.user_id = e.user_id
    JOIN public.users AS u ON u.id = e.user_id
    LEFT JOIN public.shadow_reader_classifications AS c ON c.user_id = e.user_id
    LEFT JOIN public.shadow_reader_language_snapshots AS s ON s.user_id = e.user_id
    WHERE e.event_id = p_event_id
      AND e.day_number BETWEEN 1 AND 7
      AND p.reader_group_snapshot = 'kh'
      AND u.is_active IS DISTINCT FROM false
      AND (
        c.admin_group_override = 'kh'
        OR (c.admin_group_override IS NULL
          AND COALESCE(s.khmer_stories, 0) + COALESCE(s.international_stories, 0) >= 3
          AND COALESCE(s.khmer_stories, 0) >= COALESCE(s.international_stories, 0))
      )
    GROUP BY e.user_id
    HAVING pg_catalog.sum(e.points) > 0
  ), ranked AS (
    SELECT t.user_id, t.points, t.last_score_at,
           pg_catalog.row_number() OVER (
             ORDER BY t.points DESC, t.last_score_at ASC, t.user_id ASC
           ) AS rank_number
    FROM score_totals AS t
    ORDER BY t.points DESC, t.last_score_at ASC, t.user_id ASC
    LIMIT 3
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'user_id', r.user_id,
      'rank', r.rank_number,
      'points', r.points,
      'story_cards', CASE r.rank_number WHEN 1 THEN 100 WHEN 2 THEN 70 ELSE 50 END,
      'featured_story_id', v_story_id,
      'coins', (1000 + pg_catalog.floor(pg_catalog.random() * 9001))::integer,
      'vouchers', (10 + pg_catalog.floor(pg_catalog.random() * 91))::integer
    ) ORDER BY r.rank_number
  ), '[]'::jsonb) INTO v_winners
  FROM ranked AS r;

  INSERT INTO public.shadow_read_event_overall_settlements (
    event_id, winners, awarded_count, settled_at
  ) VALUES (
    p_event_id, v_winners, pg_catalog.jsonb_array_length(v_winners), v_now
  );

  FOR v_winner IN SELECT value FROM pg_catalog.jsonb_array_elements(v_winners)
  LOOP
    v_reader := (v_winner ->> 'user_id')::uuid;
    v_rank := (v_winner ->> 'rank')::integer;
    v_cards := (v_winner ->> 'story_cards')::integer;
    v_coins := (v_winner ->> 'coins')::integer;
    v_vouchers := (v_winner ->> 'vouchers')::integer;
    v_claim_id := NULL;

    IF v_rank NOT BETWEEN 1 AND 3
       OR (v_rank = 1 AND v_cards IS DISTINCT FROM 100)
       OR (v_rank = 2 AND v_cards IS DISTINCT FROM 70)
       OR (v_rank = 3 AND v_cards IS DISTINCT FROM 50)
       OR v_coins NOT BETWEEN 1000 AND 10000
       OR v_vouchers NOT BETWEEN 10 AND 100 THEN
      RAISE EXCEPTION 'Invalid Read Event overall gift allocation';
    END IF;

    INSERT INTO public.shadow_read_event_reward_claims (
      event_id, user_id, reward_key, reward_type, rank_number,
      coin_amount, voucher_amount, card_amount, card_story_id, grant_status
    ) VALUES (
      p_event_id, v_reader, 'overall_top', 'overall_top', v_rank,
      v_coins, v_vouchers, v_cards, v_story_id, 'pending'
    )
    ON CONFLICT (event_id, user_id, reward_key) DO NOTHING
    RETURNING id INTO v_claim_id;

    IF v_claim_id IS NULL THEN
      RAISE EXCEPTION 'Overall Top 3 has conflicting reward claims';
    END IF;

    INSERT INTO public.user_wallets (
      user_id, diamond_balance, gem_balance, voucher_balance
    ) VALUES (v_reader, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.user_wallets AS w
    SET gem_balance = COALESCE(w.gem_balance, 0) + v_coins,
        voucher_balance = COALESCE(w.voucher_balance, 0) + v_vouchers,
        story_card_balance = COALESCE(w.story_card_balance, 0) + v_cards,
        updated_at = v_now
    WHERE w.user_id = v_reader;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Overall Top 3 winner wallet is unavailable';
    END IF;

    INSERT INTO public.reader_reward_history (
      user_id, source_key, source_title, amount_gems,
      amount_vouchers, story_cards, metadata
    ) VALUES (
      v_reader, 'shadow_read_event_overall_top3', 'Shadow Read Event Overall Top 3',
      v_coins, v_vouchers, v_cards,
      pg_catalog.jsonb_build_object(
        'event_id', p_event_id, 'rank', v_rank,
        'points', (v_winner ->> 'points')::bigint,
        'featured_story_id', v_story_id,
        'coins', v_coins, 'vouchers', v_vouchers,
        'story_cards', v_cards, 'claim_id', v_claim_id
      )
    );

    UPDATE public.shadow_read_event_reward_claims AS c
    SET grant_status = 'granted', granted_at = v_now
    WHERE c.id = v_claim_id AND c.grant_status = 'pending';

    GET DIAGNOSTICS v_written = ROW_COUNT;
    IF v_written <> 1 THEN
      RAISE EXCEPTION 'Overall Top 3 reward grant could not be verified';
    END IF;

    v_paid := v_paid + 1;
    v_coins_total := v_coins_total + v_coins;
    v_vouchers_total := v_vouchers_total + v_vouchers;
    v_cards_total := v_cards_total + v_cards;
  END LOOP;

  IF v_paid <> pg_catalog.jsonb_array_length(v_winners) THEN
    RAISE EXCEPTION 'Overall Top 3 reward count mismatch';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'settled', true, 'already_settled', false,
    'event_id', p_event_id, 'awarded_count', v_paid,
    'coins_added', v_coins_total, 'vouchers_added', v_vouchers_total,
    'story_cards_added', v_cards_total,
    'winners', v_winners, 'settled_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_read_event_settle_overall_top3(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_read_event_settle_overall_top3(uuid)
  TO service_role;

COMMIT;
