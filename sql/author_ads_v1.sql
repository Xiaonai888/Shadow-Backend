CREATE TABLE IF NOT EXISTS public.author_ad_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  author_page_id uuid NOT NULL,
  campaign_kind text NOT NULL CHECK (campaign_kind IN ('post', 'book')),
  content_type text NOT NULL CHECK (content_type IN ('post', 'story', 'product')),
  content_id text NOT NULL CHECK (length(btrim(content_id)) BETWEEN 1 AND 128),
  content_title text NOT NULL DEFAULT '',
  content_image_url text NOT NULL DEFAULT '',
  goal text NOT NULL CHECK (goal IN ('views', 'visits', 'readers', 'followers', 'unlocks', 'sales')),
  audience_mode text NOT NULL DEFAULT 'automatic' CHECK (audience_mode IN ('automatic', 'manual')),
  audience_filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(audience_filters) = 'object'),
  placements text[] NOT NULL DEFAULT ARRAY['discover']::text[] CHECK (placements = ARRAY['discover']::text[]),
  budget_cents bigint NOT NULL CHECK (budget_cents >= 100),
  spent_cents bigint NOT NULL DEFAULT 0 CHECK (spent_cents >= 0 AND spent_cents <= budget_cents),
  funded_cents bigint NOT NULL DEFAULT 0 CHECK (funded_cents >= 0 AND funded_cents <= budget_cents),
  refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  duration_days integer NOT NULL CHECK (duration_days BETWEEN 1 AND 30),
  start_at timestamptz,
  end_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'approved', 'scheduled', 'active', 'paused', 'completed', 'rejected', 'cancelled')),
  review_status text NOT NULL DEFAULT 'not_submitted' CHECK (review_status IN ('not_submitted', 'pending', 'approved', 'rejected')),
  review_reason text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  submitted_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT author_ad_campaign_kind_content_check CHECK (
    (campaign_kind = 'post' AND content_type = 'post' AND goal IN ('views', 'visits', 'followers')) OR
    (campaign_kind = 'book' AND content_type = 'story' AND goal IN ('readers', 'followers', 'unlocks')) OR
    (campaign_kind = 'book' AND content_type = 'product' AND goal IN ('sales', 'followers'))
  ),
  CONSTRAINT author_ad_campaign_schedule_check CHECK (
    start_at IS NULL OR end_at IS NULL OR end_at > start_at
  ),
  CONSTRAINT author_ad_campaign_live_check CHECK (
    status NOT IN ('scheduled', 'active', 'paused', 'completed') OR
    (review_status = 'approved' AND reviewed_at IS NOT NULL AND funded_cents >= budget_cents)
  ),
  CONSTRAINT author_ad_campaign_refund_check CHECK (
    refunded_cents <= funded_cents - spent_cents
  )
);

CREATE TABLE IF NOT EXISTS public.author_ad_budget_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.author_ad_campaigns(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('fund', 'spend', 'refund')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  payment_provider text,
  payment_reference text,
  event_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT author_ad_ledger_payment_check CHECK (
    entry_type <> 'fund' OR (payment_provider IS NOT NULL AND payment_reference IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.author_ad_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.author_ad_campaigns(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('impression', 'click', 'reading_start', 'follow', 'unlock', 'purchase')),
  event_key text NOT NULL UNIQUE CHECK (length(btrim(event_key)) BETWEEN 8 AND 200),
  viewer_user_id uuid,
  viewer_session_hash text,
  placement text NOT NULL DEFAULT 'discover' CHECK (placement = 'discover'),
  content_id text NOT NULL DEFAULT '',
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  attributed_revenue_cents bigint NOT NULL DEFAULT 0 CHECK (attributed_revenue_cents >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT author_ad_viewer_identifier_check CHECK (
    viewer_user_id IS NOT NULL OR (viewer_session_hash IS NOT NULL AND length(viewer_session_hash) >= 16)
  )
);

CREATE INDEX IF NOT EXISTS idx_author_ad_campaign_owner_created
  ON public.author_ad_campaigns (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_author_ad_campaign_author_status
  ON public.author_ad_campaigns (author_page_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_author_ad_campaign_discover_active
  ON public.author_ad_campaigns (start_at, end_at, updated_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_author_ad_ledger_campaign_created
  ON public.author_ad_budget_ledger (campaign_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_author_ad_ledger_provider_reference
  ON public.author_ad_budget_ledger (payment_provider, payment_reference)
  WHERE entry_type = 'fund' AND payment_provider IS NOT NULL AND payment_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_author_ad_events_campaign_type_time
  ON public.author_ad_delivery_events (campaign_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_author_ad_events_viewer_time
  ON public.author_ad_delivery_events (campaign_id, viewer_user_id, occurred_at DESC)
  WHERE viewer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_author_ad_events_session_time
  ON public.author_ad_delivery_events (campaign_id, viewer_session_hash, occurred_at DESC)
  WHERE viewer_session_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_author_ad_campaign_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_author_ad_campaign_updated_at ON public.author_ad_campaigns;

CREATE TRIGGER trg_author_ad_campaign_updated_at
BEFORE UPDATE ON public.author_ad_campaigns
FOR EACH ROW
EXECUTE FUNCTION public.touch_author_ad_campaign_updated_at();

ALTER TABLE public.author_ad_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.author_ad_budget_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.author_ad_delivery_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.author_ad_campaigns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.author_ad_budget_ledger FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.author_ad_delivery_events FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.author_ad_campaigns TO service_role;
GRANT SELECT, INSERT ON TABLE public.author_ad_budget_ledger TO service_role;
GRANT SELECT, INSERT ON TABLE public.author_ad_delivery_events TO service_role;
