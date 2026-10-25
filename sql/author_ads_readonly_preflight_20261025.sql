WITH object_checks AS (
  SELECT * FROM (VALUES
    ('table: campaigns', to_regclass('public.author_ad_campaigns') IS NOT NULL),
    ('table: diamond funding', to_regclass('public.author_ad_diamond_funding') IS NOT NULL),
    ('table: reach events', to_regclass('public.author_ad_delivery_events') IS NOT NULL),
    ('table: reader wallets', to_regclass('public.user_wallets') IS NOT NULL),
    ('RPC: reserve Diamonds', to_regprocedure('public.reserve_author_ad_diamonds_v1(uuid,uuid)') IS NOT NULL),
    ('RPC: atomic start', to_regprocedure('public.start_author_ad_campaign_with_diamonds_v1(uuid,uuid)') IS NOT NULL),
    ('RPC: lifecycle', to_regprocedure('public.transition_author_ad_campaign_v1(uuid,text)') IS NOT NULL),
    ('RPC: verified unique reach', to_regprocedure('public.record_author_ad_diamond_reach_v1(uuid,uuid,uuid,jsonb)') IS NOT NULL),
    ('RPC: refund Diamonds', to_regprocedure('public.refund_author_ad_diamonds_v1(uuid,uuid)') IS NOT NULL),
    ('RPC: expired campaigns', to_regprocedure('public.expire_due_author_ad_diamond_campaigns_v1(integer)') IS NOT NULL),
    ('trigger: live funding', EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = to_regclass('public.author_ad_campaigns')
        AND tgname = 'trg_author_ad_campaign_live_funding_v1'
        AND tgenabled <> 'D'
    )),
    ('trigger: automatic refund', EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = to_regclass('public.author_ad_campaigns')
        AND tgname = 'trg_author_ad_diamond_auto_refund_v1'
        AND tgenabled <> 'D'
    )),
    ('trigger: review/budget guard', EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = to_regclass('public.author_ad_campaigns')
        AND tgname = 'trg_author_ad_campaign_review_budget_v1'
        AND tgenabled <> 'D'
    )),
    ('constraint: unique reach event key', EXISTS (
      SELECT 1 FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'author_ad_delivery_events'
        AND indexdef ILIKE '%UNIQUE%'
        AND indexdef ILIKE '%event_key%'
    )),
    ('extension: pg_cron', EXISTS (
      SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron'
    )),
    ('RPC: current clock after row lock', COALESCE(
      position('clock_timestamp' IN pg_catalog.pg_get_functiondef(
        to_regprocedure('public.record_author_ad_diamond_reach_v1(uuid,uuid,uuid,jsonb)')
      )) > 0, false
    ))
  ) AS checks(name, passed)
)
SELECT name AS check_name,
  CASE WHEN passed THEN 'PASS' ELSE 'CHECK' END AS result
FROM object_checks
ORDER BY name;

WITH funding AS (
  SELECT f.campaign_id, f.owner_user_id, f.funded_diamonds,
    f.spent_diamonds, f.refunded_diamonds,
    c.id AS actual_campaign, c.owner_user_id AS actual_owner,
    c.budget_cents, c.funded_cents, c.spent_cents,
    c.refunded_cents, c.status, c.review_status, c.start_at, c.end_at
  FROM public.author_ad_diamond_funding AS f
  LEFT JOIN public.author_ad_campaigns AS c ON c.id = f.campaign_id
),
reach_events AS (
  SELECT e.campaign_id, e.viewer_user_id, e.event_type,
    e.event_key, e.amount_cents, e.placement, e.metadata,
    e.content_id
  FROM public.author_ad_delivery_events AS e
  WHERE e.event_key LIKE 'diamond-reach:%'
),
reach_by_campaign AS (
  SELECT campaign_id, COUNT(*)::bigint AS events
  FROM reach_events
  GROUP BY campaign_id
),
reach_duplicates AS (
  SELECT campaign_id, viewer_user_id
  FROM reach_events
  GROUP BY campaign_id, viewer_user_id
  HAVING COUNT(*) > 1
),
problems AS (
  SELECT * FROM (VALUES
    ('funding_without_campaign', (SELECT COUNT(*) FROM funding WHERE actual_campaign IS NULL)),
    ('funding_owner_mismatch', (SELECT COUNT(*) FROM funding WHERE actual_owner IS DISTINCT FROM owner_user_id)),
    ('funding_budget_mismatch', (SELECT COUNT(*) FROM funding WHERE funded_diamonds IS DISTINCT FROM budget_cents)),
    ('diamonds_mixed_with_usd', (SELECT COUNT(*) FROM funding WHERE funded_cents <> 0 OR spent_cents <> 0 OR refunded_cents <> 0)),
    ('funding_negative_or_exceeded', (SELECT COUNT(*) FROM funding WHERE spent_diamonds < 0 OR refunded_diamonds < 0 OR spent_diamonds + refunded_diamonds > funded_diamonds)),
    ('terminal_campaign_with_unreturned_diamonds', (SELECT COUNT(*) FROM funding WHERE status IN ('completed', 'cancelled', 'rejected') AND funded_diamonds > spent_diamonds + refunded_diamonds)),
    ('expired_diamond_campaign_over_15_minutes', (SELECT COUNT(*) FROM funding WHERE status IN ('active', 'paused', 'scheduled') AND end_at < clock_timestamp() - interval '15 minutes')),
    ('diamond_active_without_review', (SELECT COUNT(*) FROM funding WHERE status IN ('active', 'paused', 'scheduled') AND review_status <> 'approved')),
    ('reach_event_invalid_fields', (SELECT COUNT(*) FROM reach_events WHERE viewer_user_id IS NULL OR event_type <> 'impression' OR amount_cents <> 0 OR placement <> 'discover' OR metadata->>'billing_unit' IS DISTINCT FROM 'diamonds' OR metadata->>'charged_diamonds' IS DISTINCT FROM '1' OR NOT (metadata ? 'receipt_action_id'))),
    ('duplicate_reach_for_same_viewer', (SELECT COUNT(*) FROM reach_duplicates)),
    ('reach_without_diamond_funding', (SELECT COUNT(*) FROM reach_events e LEFT JOIN funding f ON f.campaign_id = e.campaign_id WHERE f.campaign_id IS NULL)),
    ('diamond_spent_not_equal_verified_reach', (SELECT COUNT(*) FROM funding f LEFT JOIN reach_by_campaign r ON r.campaign_id = f.campaign_id WHERE f.spent_diamonds <> COALESCE(r.events, 0)))
  ) AS t(name, issues)
)
SELECT name AS check_name, issues AS issue_count,
  CASE WHEN issues = 0 THEN 'PASS' ELSE 'INVESTIGATE' END AS result
FROM problems
ORDER BY name;

DO $audit$
DECLARE
  v_active boolean := false;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = $1 AND schedule = $2 AND active = true)'
      INTO v_active USING 'shadow-author-ad-diamond-expiry-v1', '*/5 * * * *';
    RAISE NOTICE 'Boost expiry pg_cron job active every 5 minutes: %', v_active;
  ELSE
    RAISE NOTICE 'Boost expiry pg_cron table not found; job cannot be verified';
  END IF;
END;
$audit$;
