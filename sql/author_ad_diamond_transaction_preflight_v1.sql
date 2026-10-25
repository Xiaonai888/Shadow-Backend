BEGIN;

SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '2s';

DO $boost_transaction_tests$
DECLARE
  v_missing uuid := gen_random_uuid();
  v_case record;
  v_rejected boolean;
  v_state text;
  v_passed integer := 0;
BEGIN
  WHILE EXISTS (
    SELECT 1 FROM public.author_ad_campaigns WHERE id = v_missing
  ) LOOP
    v_missing := gen_random_uuid();
  END LOOP;

  FOR v_case IN
    SELECT * FROM (VALUES
      (
        'reserve rejects NULL identity',
        'SELECT * FROM public.reserve_author_ad_diamonds_v1(NULL::uuid,NULL::uuid)',
        '22023'
      ),
      (
        'start rejects NULL identity',
        'SELECT * FROM public.start_author_ad_campaign_with_diamonds_v1(NULL::uuid,NULL::uuid)',
        '22023'
      ),
      (
        'refund rejects NULL identity',
        'SELECT * FROM public.refund_author_ad_diamonds_v1(NULL::uuid,NULL::uuid)',
        '22023'
      ),
      (
        'reach rejects NULL identity',
        'SELECT * FROM public.record_author_ad_diamond_reach_v1(NULL::uuid,NULL::uuid,NULL::uuid)',
        '22023'
      ),
      (
        'transition rejects invalid action',
        'SELECT * FROM public.transition_author_ad_campaign_v1(NULL::uuid,''invalid'')',
        '22023'
      ),
      (
        'reserve rejects nonexistent campaign',
        format('SELECT * FROM public.reserve_author_ad_diamonds_v1(%L::uuid,%L::uuid)', v_missing, v_missing),
        'P0001'
      ),
      (
        'start rejects nonexistent campaign',
        format('SELECT * FROM public.start_author_ad_campaign_with_diamonds_v1(%L::uuid,%L::uuid)', v_missing, v_missing),
        'P0002'
      ),
      (
        'refund rejects nonexistent campaign',
        format('SELECT * FROM public.refund_author_ad_diamonds_v1(%L::uuid,%L::uuid)', v_missing, v_missing),
        'P0001'
      ),
      (
        'reach rejects nonexistent campaign',
        format(
          'SELECT * FROM public.record_author_ad_diamond_reach_v1(%L::uuid,%L::uuid,%L::uuid,%L::jsonb)',
          v_missing, v_missing, v_missing,
          '{"content_type":"post","measurement":"client_reported","reported_visible_ms":1500,"reported_visible_ratio":0.8}'
        ),
        'P0002'
      ),
      (
        'transition rejects nonexistent campaign',
        format('SELECT * FROM public.transition_author_ad_campaign_v1(%L::uuid,''start'')', v_missing),
        'P0002'
      )
    ) AS checks(check_name, statement_text, expected_sqlstate)
  LOOP
    v_rejected := false;
    v_state := null;

    BEGIN
      EXECUTE v_case.statement_text;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      IF v_state IS DISTINCT FROM v_case.expected_sqlstate THEN
        RAISE EXCEPTION '% returned SQLSTATE %, expected %',
          v_case.check_name, v_state, v_case.expected_sqlstate;
      END IF;
      v_rejected := true;
    END;

    IF NOT v_rejected THEN
      RAISE EXCEPTION '% was unexpectedly accepted', v_case.check_name;
    END IF;

    v_passed := v_passed + 1;
    RAISE NOTICE 'PASS: %', v_case.check_name;
  END LOOP;

  IF v_passed <> 10 THEN
    RAISE EXCEPTION 'Invalid number of transaction safety cases';
  END IF;

  RAISE NOTICE 'PASS: % rejected transaction paths, all test calls will be rolled back', v_passed;
END;
$boost_transaction_tests$;

ROLLBACK;

WITH funding AS (
  SELECT
    f.campaign_id,
    f.owner_user_id,
    f.funded_diamonds,
    f.spent_diamonds,
    f.refunded_diamonds,
    c.id AS matched_campaign,
    c.owner_user_id AS campaign_owner,
    c.budget_cents,
    c.funded_cents,
    c.spent_cents,
    c.refunded_cents,
    c.status,
    c.review_status,
    c.end_at
  FROM public.author_ad_diamond_funding f
  LEFT JOIN public.author_ad_campaigns c ON c.id = f.campaign_id
),
reach_counts AS (
  SELECT e.campaign_id, count(*)::bigint AS unique_events
  FROM public.author_ad_delivery_events e
  WHERE e.event_key LIKE 'diamond-reach:%'
  GROUP BY e.campaign_id
),
issues AS (
  SELECT 'funding ledger has a campaign'::text AS check_name,
    count(*)::bigint AS issue_count
  FROM funding WHERE matched_campaign IS NULL

  UNION ALL
  SELECT 'funding owner matches campaign', count(*)
  FROM funding WHERE campaign_owner IS DISTINCT FROM owner_user_id

  UNION ALL
  SELECT 'funded Diamonds equal approved budget', count(*)
  FROM funding WHERE funded_diamonds IS DISTINCT FROM budget_cents

  UNION ALL
  SELECT 'Diamonds not mixed with legacy USD', count(*)
  FROM funding WHERE funded_cents <> 0 OR spent_cents <> 0 OR refunded_cents <> 0

  UNION ALL
  SELECT 'funding balance never exceeds reserved Diamonds', count(*)
  FROM funding WHERE spent_diamonds < 0 OR refunded_diamonds < 0
    OR spent_diamonds + refunded_diamonds > funded_diamonds

  UNION ALL
  SELECT 'finished campaigns have no refundable remainder', count(*)
  FROM funding WHERE status IN ('completed', 'cancelled', 'rejected')
    AND funded_diamonds > spent_diamonds + refunded_diamonds

  UNION ALL
  SELECT 'active funded campaigns have approved review', count(*)
  FROM funding WHERE status IN ('active', 'paused', 'scheduled')
    AND (review_status IS DISTINCT FROM 'approved')

  UNION ALL
  SELECT 'no funded campaign expired over 15 minutes', count(*)
  FROM funding WHERE status IN ('active', 'paused', 'scheduled')
    AND end_at < clock_timestamp() - interval '15 minutes'

  UNION ALL
  SELECT 'each Diamond spent has a recorded reach', count(*)
  FROM funding f LEFT JOIN reach_counts r ON r.campaign_id = f.campaign_id
  WHERE f.spent_diamonds <> coalesce(r.unique_events, 0)

  UNION ALL
  SELECT 'no duplicate Diamond reach viewers', count(*)
  FROM (
    SELECT campaign_id, viewer_user_id
    FROM public.author_ad_delivery_events
    WHERE event_key LIKE 'diamond-reach:%'
    GROUP BY campaign_id, viewer_user_id
    HAVING count(*) > 1
  ) duplicates

  UNION ALL
  SELECT 'atomic start RPC is installed',
    CASE WHEN to_regprocedure('public.start_author_ad_campaign_with_diamonds_v1(uuid,uuid)') IS NULL
      THEN 1::bigint ELSE 0::bigint END

  UNION ALL
  SELECT 'refund RPC is installed',
    CASE WHEN to_regprocedure('public.refund_author_ad_diamonds_v1(uuid,uuid)') IS NULL
      THEN 1::bigint ELSE 0::bigint END

  UNION ALL
  SELECT 'unique reach RPC is installed',
    CASE WHEN to_regprocedure('public.record_author_ad_diamond_reach_v1(uuid,uuid,uuid,jsonb)') IS NULL
      THEN 1::bigint ELSE 0::bigint END

  UNION ALL
  SELECT 'automatic refund trigger enabled',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = to_regclass('public.author_ad_campaigns')
        AND tgname = 'trg_author_ad_diamond_auto_refund_v1'
        AND tgenabled <> 'D'
    ) THEN 0::bigint ELSE 1::bigint END

  UNION ALL
  SELECT 'live funding trigger enabled',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = to_regclass('public.author_ad_campaigns')
        AND tgname = 'trg_author_ad_campaign_live_funding_v1'
        AND tgenabled <> 'D'
    ) THEN 0::bigint ELSE 1::bigint END
)
SELECT check_name, issue_count,
  CASE WHEN issue_count = 0 THEN 'PASS' ELSE 'INVESTIGATE' END AS result
FROM issues
ORDER BY check_name;
