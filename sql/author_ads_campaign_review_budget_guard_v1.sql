BEGIN;

CREATE OR REPLACE FUNCTION public.guard_author_ad_campaign_review_budget_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_diamond_funded boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.budget_cents NOT BETWEEN 100 AND 1000000 THEN
      RAISE EXCEPTION 'Boost budget is outside the supported range' USING ERRCODE = '22023';
    END IF;
    IF NEW.status <> 'draft'
      OR NEW.review_status <> 'not_submitted'
      OR NEW.funded_cents <> 0
      OR NEW.spent_cents <> 0
      OR NEW.refunded_cents <> 0
      OR NEW.submitted_at IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'A Boost campaign must be created as an unfunded draft'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Boost campaign identity cannot change'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'Submitted Boost campaigns cannot become drafts again'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.review_status <> 'not_submitted'
    AND NEW.review_status = 'not_submitted'
  THEN
    RAISE EXCEPTION 'Boost review history cannot be reset'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.budget_cents IS DISTINCT FROM OLD.budget_cents
    AND NEW.budget_cents NOT BETWEEN 100 AND 1000000
  THEN
    RAISE EXCEPTION 'Boost budget is outside the supported range' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.author_ad_diamond_funding AS f
    WHERE f.campaign_id = OLD.id
  ) INTO v_diamond_funded;

  IF OLD.status <> 'draft'
    OR OLD.review_status <> 'not_submitted'
    OR OLD.funded_cents <> 0
    OR OLD.spent_cents <> 0
    OR OLD.refunded_cents <> 0
    OR v_diamond_funded
  THEN
    IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.author_page_id IS DISTINCT FROM OLD.author_page_id
      OR NEW.campaign_kind IS DISTINCT FROM OLD.campaign_kind
      OR NEW.content_type IS DISTINCT FROM OLD.content_type
      OR NEW.content_id IS DISTINCT FROM OLD.content_id
      OR NEW.content_title IS DISTINCT FROM OLD.content_title
      OR NEW.content_image_url IS DISTINCT FROM OLD.content_image_url
      OR NEW.goal IS DISTINCT FROM OLD.goal
      OR NEW.audience_mode IS DISTINCT FROM OLD.audience_mode
      OR NEW.audience_filters IS DISTINCT FROM OLD.audience_filters
      OR NEW.placements IS DISTINCT FROM OLD.placements
      OR NEW.budget_cents IS DISTINCT FROM OLD.budget_cents
      OR NEW.duration_days IS DISTINCT FROM OLD.duration_days
      OR NEW.currency IS DISTINCT FROM OLD.currency
    THEN
      RAISE EXCEPTION 'Boost campaign details cannot change after submission or funding'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF OLD.status IN ('completed', 'cancelled', 'rejected')
    AND NEW.status IS DISTINCT FROM OLD.status
  THEN
    RAISE EXCEPTION 'Finished Boost campaigns cannot be restarted'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.review_status = 'approved'
    AND NEW.review_status IS DISTINCT FROM 'approved'
  THEN
    RAISE EXCEPTION 'An approved Boost review cannot be reversed'
      USING ERRCODE = 'P0001';
  END IF;

  IF (NEW.status = 'pending_review'
      AND (NEW.review_status <> 'pending' OR NEW.submitted_at IS NULL))
    OR (NEW.status = 'approved'
      AND (NEW.review_status <> 'approved' OR NEW.reviewed_at IS NULL))
    OR (NEW.status = 'rejected'
      AND (NEW.review_status <> 'rejected' OR NEW.reviewed_at IS NULL))
  THEN
    RAISE EXCEPTION 'Boost campaign status and review status are inconsistent'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'pending_review'
    AND OLD.status IS DISTINCT FROM 'pending_review'
  THEN
    IF OLD.status <> 'draft'
      OR OLD.review_status <> 'not_submitted'
      OR NEW.review_status <> 'pending'
      OR NEW.submitted_at IS NULL
      OR OLD.funded_cents <> 0
      OR OLD.spent_cents <> 0
      OR OLD.refunded_cents <> 0
      OR v_diamond_funded
    THEN
      RAISE EXCEPTION 'Only an unfunded draft can be submitted for review'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.review_status IS DISTINCT FROM OLD.review_status
    AND NEW.review_status IN ('approved', 'rejected')
  THEN
    IF OLD.status <> 'pending_review'
      OR OLD.review_status <> 'pending'
      OR NEW.status <> NEW.review_status
      OR NEW.reviewed_at IS NULL
      OR OLD.submitted_at IS NULL
      OR OLD.funded_cents <> 0
      OR OLD.spent_cents <> 0
      OR OLD.refunded_cents <> 0
      OR v_diamond_funded
    THEN
      RAISE EXCEPTION 'Boost review must be completed from an unfunded pending campaign'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_author_ad_campaign_review_budget_v1()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_author_ad_campaign_review_budget_v1
  ON public.author_ad_campaigns;

CREATE TRIGGER trg_author_ad_campaign_review_budget_v1
BEFORE INSERT OR UPDATE ON public.author_ad_campaigns
FOR EACH ROW
EXECUTE FUNCTION public.guard_author_ad_campaign_review_budget_v1();

COMMIT;
