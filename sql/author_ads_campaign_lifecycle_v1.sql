BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_author_ad_campaign_live_funding_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_funding public.author_ad_diamond_funding%ROWTYPE;
BEGIN
  IF NEW.status NOT IN ('scheduled', 'active', 'paused', 'completed') THEN
    RETURN NEW;
  END IF;

  IF NEW.review_status <> 'approved' OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'Live campaign requires approved review' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.funded_cents >= NEW.budget_cents THEN
    IF NEW.status IN ('scheduled', 'active', 'paused')
      AND (NEW.funded_cents - NEW.refunded_cents < NEW.budget_cents
        OR NEW.funded_cents - NEW.refunded_cents - NEW.spent_cents <= 0)
    THEN
      RAISE EXCEPTION 'Live campaign USD funding is unavailable' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  SELECT f.* INTO v_funding
  FROM public.author_ad_diamond_funding AS f
  WHERE f.campaign_id = NEW.id
  FOR UPDATE;

  IF NOT FOUND
    OR v_funding.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR v_funding.funded_diamonds IS DISTINCT FROM NEW.budget_cents
    OR v_funding.spent_diamonds + v_funding.refunded_diamonds > v_funding.funded_diamonds
    OR NEW.funded_cents <> 0
    OR NEW.spent_cents <> 0
    OR NEW.refunded_cents <> 0
  THEN
    RAISE EXCEPTION 'Live campaign Diamonds funding is invalid' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status IN ('scheduled', 'active', 'paused')
    AND v_funding.spent_diamonds + v_funding.refunded_diamonds >= v_funding.funded_diamonds
  THEN
    RAISE EXCEPTION 'Live campaign Diamonds funding is exhausted' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER TABLE public.author_ad_campaigns
  DROP CONSTRAINT IF EXISTS author_ad_campaign_live_check;

ALTER TABLE public.author_ad_campaigns
  ADD CONSTRAINT author_ad_campaign_live_check CHECK (
    status NOT IN ('scheduled', 'active', 'paused', 'completed')
    OR (review_status = 'approved' AND reviewed_at IS NOT NULL)
  );

DROP TRIGGER IF EXISTS trg_author_ad_campaign_live_funding_v1
  ON public.author_ad_campaigns;

CREATE TRIGGER trg_author_ad_campaign_live_funding_v1
BEFORE INSERT OR UPDATE ON public.author_ad_campaigns
FOR EACH ROW
EXECUTE FUNCTION public.enforce_author_ad_campaign_live_funding_v1();

REVOKE ALL ON FUNCTION public.enforce_author_ad_campaign_live_funding_v1()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enforce_author_ad_campaign_live_funding_v1()
  TO service_role;

CREATE OR REPLACE FUNCTION public.transition_author_ad_campaign_v1(
  p_campaign_id uuid,
  p_action text
)
RETURNS TABLE (
  changed boolean,
  campaign_id uuid,
  campaign_status text,
  starts_at timestamptz,
  ends_at timestamptz,
  funded_cents bigint,
  spent_cents bigint,
  available_cents bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_campaign public.author_ad_campaigns%ROWTYPE;
  v_now timestamptz := now();
  v_next_status text;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_content_available boolean := false;
  v_diamond_funding public.author_ad_diamond_funding%ROWTYPE;
  v_has_diamond_funding boolean := false;
BEGIN
  IF p_campaign_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('start', 'pause', 'resume', 'expire')
  THEN
    RAISE EXCEPTION 'Invalid author ad campaign transition' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_campaign
  FROM public.author_ad_campaigns AS c
  WHERE c.id = p_campaign_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Author ad campaign not found' USING ERRCODE = 'P0002';
  END IF;

  v_next_status := v_campaign.status;
  v_start_at := v_campaign.start_at;
  v_end_at := v_campaign.end_at;

  IF (p_action = 'start' AND v_campaign.status = 'active')
    OR (p_action = 'pause' AND v_campaign.status = 'paused')
    OR (p_action = 'resume' AND v_campaign.status = 'active')
    OR (p_action = 'expire' AND v_campaign.status = 'completed')
  THEN
    RETURN QUERY SELECT false, v_campaign.id, v_campaign.status,
      v_start_at, v_end_at, v_campaign.funded_cents,
      v_campaign.spent_cents,
      GREATEST(v_campaign.funded_cents - v_campaign.refunded_cents - v_campaign.spent_cents, 0::bigint);
    RETURN;
  END IF;

  IF p_action = 'start' THEN
    IF v_campaign.status <> 'approved'
      OR v_campaign.start_at IS NOT NULL OR v_campaign.end_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'Only an approved, unstarted campaign can be started' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_action = 'pause' THEN
    IF v_campaign.status <> 'active'
      OR v_campaign.end_at IS NULL OR v_now >= v_campaign.end_at
    THEN
      RAISE EXCEPTION 'Campaign is not active within its delivery window' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_action = 'resume' THEN
    IF v_campaign.status <> 'paused'
      OR v_campaign.start_at IS NULL OR v_campaign.end_at IS NULL
      OR v_now < v_campaign.start_at OR v_now >= v_campaign.end_at
    THEN
      RAISE EXCEPTION 'Paused campaign delivery window has expired or is invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_action = 'expire' THEN
    IF v_campaign.status NOT IN ('active', 'paused', 'scheduled')
      OR v_campaign.end_at IS NULL OR v_now < v_campaign.end_at
    THEN
      RAISE EXCEPTION 'Campaign has not reached its end time' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_action IN ('start', 'resume') THEN
    SELECT f.* INTO v_diamond_funding
    FROM public.author_ad_diamond_funding AS f
    WHERE f.campaign_id = v_campaign.id
    FOR UPDATE;
    v_has_diamond_funding := FOUND;

    IF v_campaign.review_status <> 'approved'
      OR v_campaign.reviewed_at IS NULL
      OR v_campaign.currency <> 'USD'
    THEN
      RAISE EXCEPTION 'Campaign is not approved for delivery' USING ERRCODE = 'P0001';
    END IF;

    IF v_has_diamond_funding THEN
      IF v_diamond_funding.owner_user_id IS DISTINCT FROM v_campaign.owner_user_id
        OR v_diamond_funding.funded_diamonds IS DISTINCT FROM v_campaign.budget_cents
        OR v_diamond_funding.spent_diamonds + v_diamond_funding.refunded_diamonds
          >= v_diamond_funding.funded_diamonds
        OR v_campaign.funded_cents <> 0
        OR v_campaign.spent_cents <> 0
        OR v_campaign.refunded_cents <> 0
      THEN
        RAISE EXCEPTION 'Campaign Diamonds funding is not available for delivery' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_campaign.funded_cents < v_campaign.budget_cents
      OR v_campaign.funded_cents - v_campaign.refunded_cents < v_campaign.budget_cents
      OR v_campaign.spent_cents >= v_campaign.budget_cents
    THEN
      RAISE EXCEPTION 'Campaign is not fully funded for delivery' USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.author_pages AS a
      WHERE a.id = v_campaign.author_page_id
        AND a.user_id = v_campaign.owner_user_id
        AND a.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Author Page is not active' USING ERRCODE = 'P0001';
    END IF;

    IF v_campaign.content_type = 'post' THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.author_page_posts AS p
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(to_jsonb(p.image_urls)) = 'array'
            THEN to_jsonb(p.image_urls) ELSE '[]'::jsonb END
        ) AS image(url)
        WHERE p.id::text = v_campaign.content_id
          AND p.author_page_id = v_campaign.author_page_id
          AND p.user_id = v_campaign.owner_user_id
          AND p.status = 'active'
          AND btrim(image.url) <> ''
      ) INTO v_content_available;
    ELSIF v_campaign.content_type = 'story' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.stories AS s
        WHERE s.id::text = v_campaign.content_id
          AND s.author_id = v_campaign.author_page_id
          AND s.status = 'published'
          AND s.deleted_at IS NULL
      ) INTO v_content_available;
    ELSIF v_campaign.content_type = 'product' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.author_store_products AS p
        WHERE p.id::text = v_campaign.content_id
          AND p.author_page_id = v_campaign.author_page_id
          AND p.status = 'active'
          AND p.product_type IN ('book', 'pdf')
      ) INTO v_content_available;
    END IF;

    IF NOT v_content_available THEN
      RAISE EXCEPTION 'Campaign content is no longer available' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_action = 'start' THEN
    v_next_status := 'active';
    v_start_at := v_now;
    v_end_at := v_now + make_interval(days => v_campaign.duration_days);
  ELSIF p_action = 'pause' THEN
    v_next_status := 'paused';
  ELSIF p_action = 'resume' THEN
    v_next_status := 'active';
  ELSE
    v_next_status := 'completed';
  END IF;

  UPDATE public.author_ad_campaigns AS c
  SET status = v_next_status,
      start_at = v_start_at,
      end_at = v_end_at,
      completed_at = CASE WHEN v_next_status = 'completed' THEN v_now ELSE c.completed_at END
  WHERE c.id = v_campaign.id;

  RETURN QUERY SELECT true, v_campaign.id, v_next_status,
    v_start_at, v_end_at, v_campaign.funded_cents,
    v_campaign.spent_cents,
    GREATEST(v_campaign.funded_cents - v_campaign.refunded_cents - v_campaign.spent_cents, 0::bigint);
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_author_ad_campaign_v1(uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.transition_author_ad_campaign_v1(uuid, text)
  TO service_role;

COMMIT;
