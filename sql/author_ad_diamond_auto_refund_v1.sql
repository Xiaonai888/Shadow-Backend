BEGIN;

CREATE OR REPLACE FUNCTION public.auto_refund_author_ad_diamonds_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status
    OR NEW.status NOT IN ('cancelled', 'rejected', 'completed')
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.author_ad_diamond_funding AS f
    WHERE f.campaign_id = NEW.id
      AND f.funded_diamonds > f.spent_diamonds + f.refunded_diamonds
  ) THEN
    PERFORM public.refund_author_ad_diamonds_v1(NEW.id, NEW.owner_user_id);
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_refund_author_ad_diamonds_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_refund_author_ad_diamonds_v1()
  TO service_role;

DROP TRIGGER IF EXISTS trg_author_ad_diamond_auto_refund_v1
  ON public.author_ad_campaigns;

CREATE TRIGGER trg_author_ad_diamond_auto_refund_v1
AFTER UPDATE ON public.author_ad_campaigns
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  AND NEW.status IN ('cancelled', 'rejected', 'completed')
)
EXECUTE FUNCTION public.auto_refund_author_ad_diamonds_v1();

COMMIT;
