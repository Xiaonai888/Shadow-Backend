BEGIN;

CREATE INDEX IF NOT EXISTS author_ad_campaigns_due_expiry_idx
ON public.author_ad_campaigns (end_at, id)
WHERE status IN ('active', 'paused', 'scheduled')
  AND end_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.expire_due_author_ad_diamond_campaigns_v1(
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  expired_count integer,
  failed_count integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_campaign record;
  v_expired integer := 0;
  v_failed integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid Boost expiration batch size' USING ERRCODE = '22023';
  END IF;

  FOR v_campaign IN
    SELECT c.id
    FROM public.author_ad_campaigns AS c
    JOIN public.author_ad_diamond_funding AS f ON f.campaign_id = c.id
    WHERE c.status IN ('active', 'paused', 'scheduled')
      AND c.end_at IS NOT NULL
      AND c.end_at <= now()
      AND f.owner_user_id = c.owner_user_id
      AND f.funded_diamonds = c.budget_cents
    ORDER BY c.end_at, c.id
    LIMIT p_limit
    FOR UPDATE OF c SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.transition_author_ad_campaign_v1(v_campaign.id, 'expire');
      v_expired := v_expired + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'Boost Diamond campaign expiration failed for %: % (%)',
        v_campaign.id, SQLERRM, SQLSTATE;
    END;
  END LOOP;

  RETURN QUERY SELECT v_expired, v_failed;
END;
$function$;

REVOKE ALL ON FUNCTION public.expire_due_author_ad_diamond_campaigns_v1(integer)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.expire_due_author_ad_diamond_campaigns_v1(integer)
TO service_role;

DO $schedule$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron'
  ) THEN
    RAISE EXCEPTION 'pg_cron extension is required to schedule Boost Diamond campaign expiration';
  END IF;

  PERFORM cron.schedule(
    'shadow-author-ad-diamond-expiry-v1',
    '*/5 * * * *',
    'SELECT * FROM public.expire_due_author_ad_diamond_campaigns_v1(50)'
  );
END;
$schedule$;

COMMIT;
