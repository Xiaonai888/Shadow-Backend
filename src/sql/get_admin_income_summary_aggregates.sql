CREATE OR REPLACE FUNCTION public.get_admin_income_summary_aggregates(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_episode record;
  v_gift record;
  v_store record;
  v_mall record;
  v_withdrawals record;
  v_episode_order_count bigint := 0;
  v_episode_difference numeric := 0;
  v_gift_difference numeric := 0;
BEGIN
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_to <= p_from THEN
    RAISE EXCEPTION 'Invalid income date range';
  END IF;

  SELECT
    COUNT(*) AS row_count,
    COALESCE(SUM(COALESCE(paid_diamonds, 0)::numeric * COALESCE(NULLIF(diamond_to_usd_rate::numeric, 0), 0.01)), 0) AS gross,
    COALESCE(SUM(COALESCE(net_paid_diamonds, 0)::numeric * COALESCE(NULLIF(diamond_to_usd_rate::numeric, 0), 0.01)), 0) AS distributable,
    COALESCE(SUM(COALESCE(author_earned_diamonds, 0)::numeric * COALESCE(NULLIF(diamond_to_usd_rate::numeric, 0), 0.01)), 0) AS author_earned,
    COALESCE(SUM(COALESCE(platform_earned_diamonds, 0)::numeric * COALESCE(NULLIF(diamond_to_usd_rate::numeric, 0), 0.01)), 0) AS platform_earned,
    COALESCE(SUM(COALESCE(author_net_payout_usd, 0)::numeric), 0) AS net_payout,
    COALESCE(SUM(COALESCE(withholding_amount_usd, 0)::numeric), 0) AS withholding,
    COALESCE(SUM(COALESCE(author_net_payout_usd, 0)::numeric) FILTER (WHERE earning_status IN ('pending', 'available')), 0) AS pending,
    COALESCE(SUM(COALESCE(author_net_payout_usd, 0)::numeric) FILTER (WHERE earning_status = 'paid'), 0) AS paid
  INTO v_episode
  FROM public.author_earnings
  WHERE currency = 'diamond'
    AND source_type = 'diamond_unlock'
    AND earning_status <> 'void'
    AND (p_from IS NULL OR created_at >= p_from)
    AND (p_to IS NULL OR created_at < p_to);

  SELECT COUNT(DISTINCT NULLIF(BTRIM(purchase_key::text), ''))
  INTO v_episode_order_count
  FROM public.story_reading_income_transactions
  WHERE currency = 'diamond'
    AND income_status <> 'void'
    AND (p_from IS NULL OR created_at >= p_from)
    AND (p_to IS NULL OR created_at < p_to);

  SELECT
    COUNT(*) AS row_count,
    COALESCE(SUM(COALESCE(paid_diamonds, 0)::numeric * COALESCE(NULLIF(diamond_to_usd_rate::numeric, 0), 0.01)), 0) AS gross,
    COALESCE(SUM(COALESCE(net_paid_diamonds, 0)::numeric * COALESCE(NULLIF(diamond_to_usd_rate::numeric, 0), 0.01)), 0) AS distributable,
    COALESCE(SUM(COALESCE(author_earned_diamonds, 0)::numeric * COALESCE(NULLIF(diamond_to_usd_rate::numeric, 0), 0.01)), 0) AS author_earned,
    COALESCE(SUM(COALESCE(platform_earned_diamonds, 0)::numeric * COALESCE(NULLIF(diamond_to_usd_rate::numeric, 0), 0.01)), 0) AS platform_earned,
    COALESCE(SUM(COALESCE(author_net_payout_usd, 0)::numeric), 0) AS net_payout,
    COALESCE(SUM(COALESCE(withholding_amount_usd, 0)::numeric), 0) AS withholding,
    COALESCE(SUM(COALESCE(author_net_payout_usd, 0)::numeric) FILTER (WHERE earning_status IN ('pending', 'available')), 0) AS pending,
    COALESCE(SUM(COALESCE(author_net_payout_usd, 0)::numeric) FILTER (WHERE earning_status = 'paid'), 0) AS paid
  INTO v_gift
  FROM public.author_earnings
  WHERE currency = 'diamond'
    AND source_type = 'diamond_gift'
    AND earning_status <> 'void'
    AND (p_from IS NULL OR created_at >= p_from)
    AND (p_to IS NULL OR created_at < p_to);

  SELECT
    COUNT(*) AS row_count,
    COALESCE(SUM(COALESCE(product_subtotal_usd, 0)::numeric), 0) AS gross,
    COALESCE(SUM(COALESCE(platform_fee_usd, 0)::numeric), 0) AS platform_earned,
    COALESCE(SUM(COALESCE(author_income_usd, 0)::numeric), 0) AS author_earned
  INTO v_store
  FROM public.author_store_orders
  WHERE payment_status = 'paid'
    AND (p_from IS NULL OR created_at >= p_from)
    AND (p_to IS NULL OR created_at < p_to);

  SELECT
    COUNT(*) AS row_count,
    COALESCE(SUM(COALESCE(subtotal_usd, 0)::numeric), 0) AS gross,
    COALESCE(SUM(COALESCE(delivery_fee_usd, 0)::numeric), 0) AS shipping
  INTO v_mall
  FROM public.shadow_mall_orders
  WHERE status IN ('under_review', 'confirmed', 'preparing', 'shipped', 'completed')
    AND (p_from IS NULL OR created_at >= p_from)
    AND (p_to IS NULL OR created_at < p_to);

  SELECT
    COUNT(*) AS row_count,
    COALESCE(SUM(COALESCE(amount_usd, 0)::numeric) FILTER (WHERE status = 'in_review'), 0) AS in_review,
    COALESCE(SUM(COALESCE(amount_usd, 0)::numeric) FILTER (WHERE status = 'approved'), 0) AS approved,
    COALESCE(SUM(COALESCE(amount_usd, 0)::numeric) FILTER (WHERE status = 'paid'), 0) AS paid,
    COALESCE(SUM(COALESCE(amount_usd, 0)::numeric) FILTER (WHERE status = 'rejected'), 0) AS rejected
  INTO v_withdrawals
  FROM public.author_store_withdrawal_requests
  WHERE deleted_at IS NULL
    AND (p_from IS NULL OR created_at >= p_from)
    AND (p_to IS NULL OR created_at < p_to);

  v_episode_difference := v_episode.distributable - v_episode.author_earned - v_episode.platform_earned;
  v_gift_difference := v_gift.distributable - v_gift.author_earned - v_gift.platform_earned;

  RETURN jsonb_build_object(
    'episode', jsonb_build_object(
      'source', 'episode_sales',
      'gross_sales_usd', ROUND(v_episode.gross, 2),
      'direct_cost_usd', ROUND(GREATEST(0, v_episode.gross - v_episode.distributable), 2),
      'distributable_revenue_usd', ROUND(v_episode.distributable, 2),
      'platform_income_usd', ROUND(v_episode.platform_earned, 2),
      'author_earnings_usd', ROUND(v_episode.author_earned, 2),
      'author_net_payout_usd', ROUND(v_episode.net_payout, 2),
      'withholding_usd', ROUND(v_episode.withholding, 2),
      'pending_payout_usd', ROUND(v_episode.pending, 2),
      'paid_payout_usd', ROUND(v_episode.paid, 2),
      'order_count', v_episode_order_count,
      'earning_row_count', v_episode.row_count,
      'order_count_source', 'story_reading_income_transactions',
      'revenue_source', 'author_earnings',
      'reconciliation_status', CASE WHEN ABS(v_episode_difference) <= 0.000001 THEN 'passed' ELSE 'failed' END,
      'reconciliation_difference_usd', ROUND(v_episode_difference, 6)
    ),
    'diamond_gift', jsonb_build_object(
      'source', 'diamond_gifts',
      'gross_sales_usd', ROUND(v_gift.gross, 2),
      'direct_cost_usd', ROUND(GREATEST(0, v_gift.gross - v_gift.distributable), 2),
      'distributable_revenue_usd', ROUND(v_gift.distributable, 2),
      'platform_income_usd', ROUND(v_gift.platform_earned, 2),
      'author_earnings_usd', ROUND(v_gift.author_earned, 2),
      'author_net_payout_usd', ROUND(v_gift.net_payout, 2),
      'withholding_usd', ROUND(v_gift.withholding, 2),
      'pending_payout_usd', ROUND(v_gift.pending, 2),
      'paid_payout_usd', ROUND(v_gift.paid, 2),
      'order_count', 0,
      'gift_transaction_count', v_gift.row_count,
      'earning_row_count', v_gift.row_count,
      'revenue_source', 'author_earnings',
      'reconciliation_status', CASE WHEN ABS(v_gift_difference) <= 0.000001 THEN 'passed' ELSE 'failed' END,
      'reconciliation_difference_usd', ROUND(v_gift_difference, 6)
    ),
    'author_store', jsonb_build_object(
      'source', 'author_store',
      'gross_sales_usd', ROUND(v_store.gross, 2),
      'platform_income_usd', ROUND(v_store.platform_earned, 2),
      'author_earnings_usd', ROUND(v_store.author_earned, 2),
      'pending_payout_usd', ROUND(v_store.author_earned, 2),
      'order_count', v_store.row_count
    ),
    'shadow_mall', jsonb_build_object(
      'source', 'shadow_mall',
      'gross_sales_usd', ROUND(v_mall.gross, 2),
      'platform_income_usd', ROUND(v_mall.gross, 2),
      'author_earnings_usd', 0,
      'pending_payout_usd', 0,
      'shipping_fee_usd', ROUND(v_mall.shipping, 2),
      'order_count', v_mall.row_count
    ),
    'withdrawals', jsonb_build_object(
      'in_review_usd', ROUND(v_withdrawals.in_review, 2),
      'approved_usd', ROUND(v_withdrawals.approved, 2),
      'paid_usd', ROUND(v_withdrawals.paid, 2),
      'rejected_usd', ROUND(v_withdrawals.rejected, 2),
      'request_count', v_withdrawals.row_count
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_income_summary_aggregates(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_income_summary_aggregates(timestamptz, timestamptz) TO service_role;
