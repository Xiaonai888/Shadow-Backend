CREATE OR REPLACE FUNCTION public.get_admin_author_ad_money_totals_v1()
RETURNS TABLE (
  campaign_kind text,
  campaign_count bigint,
  campaigns_with_spend bigint,
  budget_cents bigint,
  funded_cents bigint,
  spent_cents bigint,
  refunded_cents bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    COALESCE(c.campaign_kind, 'all')::text,
    COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE c.spent_cents > 0)::bigint,
    COALESCE(SUM(c.budget_cents), 0)::bigint,
    COALESCE(SUM(c.funded_cents), 0)::bigint,
    COALESCE(SUM(c.spent_cents), 0)::bigint,
    COALESCE(SUM(c.refunded_cents), 0)::bigint
  FROM public.author_ad_campaigns AS c
  GROUP BY ROLLUP (c.campaign_kind);
$$;

REVOKE ALL ON FUNCTION public.get_admin_author_ad_money_totals_v1()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_admin_author_ad_money_totals_v1()
TO service_role;
