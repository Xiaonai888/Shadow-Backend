CREATE TABLE IF NOT EXISTS public.shadow_boost_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('post', 'book')),
  content_id text NOT NULL,
  author_id text NOT NULL,
  title text NOT NULL,
  author_name text NOT NULL,
  cover_url text,
  placement text NOT NULL DEFAULT 'Discover',
  goal_kind text NOT NULL DEFAULT 'reach' CHECK (goal_kind IN ('reach', 'clicks', 'engagements', 'followers', 'opens', 'reads', 'unlocks', 'sales')),
  goal_target integer NOT NULL DEFAULT 0 CHECK (goal_target >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'scheduled', 'active', 'paused', 'completed', 'expired', 'rejected', 'cancelled')),
  fee_paid_cents bigint NOT NULL DEFAULT 0 CHECK (fee_paid_cents >= 0),
  fee_verified_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_boost_campaign_dates CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at <= ends_at)
);

CREATE TABLE IF NOT EXISTS public.shadow_boost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE CHECK (length(event_key) = 64),
  campaign_id uuid NOT NULL REFERENCES public.shadow_boost_campaigns(id) ON DELETE RESTRICT,
  visitor_key text NOT NULL CHECK (length(visitor_key) = 64),
  event_kind text NOT NULL CHECK (event_kind IN ('impression', 'click', 'engagement', 'follow', 'open', 'read', 'unlock')),
  event_day date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Phnom_Penh')::date),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shadow_reader_interest_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE CHECK (length(event_key) = 64),
  visitor_key text NOT NULL CHECK (length(visitor_key) = 64),
  event_kind text NOT NULL CHECK (event_kind IN ('impression', 'open', 'read', 'save', 'follow', 'unlock')),
  source_key text NOT NULL CHECK (length(source_key) = 64),
  genre text,
  tags text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(tags) <= 10),
  event_day date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Phnom_Penh')::date),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shadow_boost_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.shadow_boost_campaigns(id) ON DELETE RESTRICT,
  purchase_kind text NOT NULL CHECK (purchase_kind IN ('episode', 'book', 'pdf')),
  order_key text NOT NULL CHECK (length(order_key) = 64),
  gross_cents bigint NOT NULL CHECK (gross_cents >= 0),
  platform_share_cents bigint NOT NULL CHECK (platform_share_cents >= 0 AND platform_share_cents <= gross_cents),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_boost_conversion_order_unique UNIQUE (purchase_kind, order_key)
);

CREATE INDEX IF NOT EXISTS shadow_boost_campaigns_kind_dates_idx ON public.shadow_boost_campaigns (kind, starts_at, ends_at, created_at DESC);
CREATE INDEX IF NOT EXISTS shadow_boost_campaigns_fee_date_idx ON public.shadow_boost_campaigns (kind, fee_verified_at);
CREATE INDEX IF NOT EXISTS shadow_boost_events_day_campaign_idx ON public.shadow_boost_events (event_day, campaign_id, event_kind);
CREATE INDEX IF NOT EXISTS shadow_boost_events_prune_idx ON public.shadow_boost_events (event_day, id);
CREATE INDEX IF NOT EXISTS shadow_boost_events_attribution_idx ON public.shadow_boost_events (campaign_id, visitor_key, event_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS shadow_boost_reader_interests_day_kind_idx ON public.shadow_reader_interest_events (event_day, event_kind);
CREATE INDEX IF NOT EXISTS shadow_boost_reader_interests_prune_idx ON public.shadow_reader_interest_events (event_day, id);
CREATE INDEX IF NOT EXISTS shadow_boost_conversions_campaign_date_idx ON public.shadow_boost_conversions (campaign_id, verified_at);

ALTER TABLE public.shadow_boost_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_boost_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_reader_interest_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_boost_conversions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shadow_boost_campaigns, public.shadow_boost_events, public.shadow_reader_interest_events, public.shadow_boost_conversions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shadow_boost_campaigns, public.shadow_boost_events, public.shadow_reader_interest_events, public.shadow_boost_conversions TO service_role;

CREATE OR REPLACE FUNCTION public.get_shadow_boost_reader_insights(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_report jsonb;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end OR
     p_end >= (now() AT TIME ZONE 'Asia/Phnom_Penh')::date OR
     p_end - p_start > 365 THEN
    RAISE EXCEPTION 'Invalid Boost report period' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'metrics', (
      SELECT jsonb_build_object(
        'interested_readers', count(DISTINCT visitor_key),
        'reading_actions', count(*) FILTER (WHERE event_kind IN ('open', 'read')),
        'saves_follows', count(*) FILTER (WHERE event_kind IN ('save', 'follow')),
        'unlocks', count(*) FILTER (WHERE event_kind = 'unlock')
      )
      FROM public.shadow_reader_interest_events
      WHERE event_day BETWEEN p_start AND p_end
    ),
    'trend', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('day', d.day::date::text, 'value', COALESCE(c.total, 0)) ORDER BY d.day)
      FROM generate_series(GREATEST(p_start, p_end - 30)::timestamp, p_end::timestamp, interval '1 day') AS d(day)
      LEFT JOIN (
        SELECT event_day, count(*) AS total
        FROM public.shadow_reader_interest_events
        WHERE event_day BETWEEN GREATEST(p_start, p_end - 30) AND p_end
        GROUP BY event_day
      ) c ON c.event_day = d.day::date
    ), '[]'::jsonb),
    'funnel', (
      SELECT jsonb_build_object(
        'impressions', count(*) FILTER (WHERE event_kind = 'impression'),
        'opens', count(*) FILTER (WHERE event_kind = 'open'),
        'reads', count(*) FILTER (WHERE event_kind = 'read'),
        'unlocks', count(*) FILTER (WHERE event_kind = 'unlock')
      )
      FROM public.shadow_reader_interest_events
      WHERE event_day BETWEEN p_start AND p_end
    ),
    'genres', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', ranked.name, 'count', ranked.total) ORDER BY ranked.total DESC, ranked.name)
      FROM (
        SELECT genre AS name, count(*) AS total
        FROM public.shadow_reader_interest_events
        WHERE event_day BETWEEN p_start AND p_end AND genre IS NOT NULL AND btrim(genre) <> ''
        GROUP BY genre
        ORDER BY total DESC, genre
        LIMIT 6
      ) ranked
    ), '[]'::jsonb),
    'tags', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', ranked.name, 'count', ranked.total) ORDER BY ranked.total DESC, ranked.name)
      FROM (
        SELECT tag.name, count(*) AS total
        FROM public.shadow_reader_interest_events e
        CROSS JOIN LATERAL unnest(e.tags) AS tag(name)
        WHERE e.event_day BETWEEN p_start AND p_end AND btrim(tag.name) <> ''
        GROUP BY tag.name
        ORDER BY total DESC, tag.name
        LIMIT 6
      ) ranked
    ), '[]'::jsonb)
  ) INTO v_report;

  RETURN v_report;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_shadow_boost_author_insights(
  p_kind text,
  p_start date,
  p_end date,
  p_page integer DEFAULT 1,
  p_limit integer DEFAULT 20,
  p_search text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_from timestamptz;
  v_until timestamptz;
  v_report jsonb;
  v_search text := btrim(COALESCE(p_search, ''));
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('post', 'book') OR
     p_start IS NULL OR p_end IS NULL OR p_start > p_end OR
     p_end >= (now() AT TIME ZONE 'Asia/Phnom_Penh')::date OR
     p_end - p_start > 365 OR
     p_page IS NULL OR p_page < 1 OR p_page > 100000 OR
     p_limit IS NULL OR p_limit < 1 OR p_limit > 20 OR
     length(v_search) > 80 THEN
    RAISE EXCEPTION 'Invalid Boost report filters' USING ERRCODE = '22023';
  END IF;

  v_from := p_start::timestamp AT TIME ZONE 'Asia/Phnom_Penh';
  v_until := (p_end + 1)::timestamp AT TIME ZONE 'Asia/Phnom_Penh';

  WITH scope AS MATERIALIZED (
    SELECT c.*
    FROM public.shadow_boost_campaigns c
    WHERE c.kind = p_kind
      AND (
        (c.starts_at IS NOT NULL AND c.starts_at < v_until AND (c.ends_at IS NULL OR c.ends_at >= v_from))
        OR (c.fee_verified_at >= v_from AND c.fee_verified_at < v_until)
        OR EXISTS (
          SELECT 1 FROM public.shadow_boost_conversions x
          WHERE x.campaign_id = c.id AND x.verified_at >= v_from AND x.verified_at < v_until
        )
      )
  ),
  event_totals AS MATERIALIZED (
    SELECT e.campaign_id,
      count(*) FILTER (WHERE e.event_kind = 'impression') AS impressions,
      count(DISTINCT e.visitor_key) FILTER (WHERE e.event_kind = 'impression') AS reach,
      count(*) FILTER (WHERE e.event_kind = 'click') AS clicks,
      count(*) FILTER (WHERE e.event_kind = 'engagement') AS engagements,
      count(*) FILTER (WHERE e.event_kind = 'follow') AS followers,
      count(*) FILTER (WHERE e.event_kind = 'open') AS opens,
      count(*) FILTER (WHERE e.event_kind = 'read') AS reads,
      count(*) FILTER (WHERE e.event_kind = 'unlock') AS unlocks
    FROM public.shadow_boost_events e
    JOIN scope c ON c.id = e.campaign_id
    WHERE e.event_day BETWEEN p_start AND p_end
    GROUP BY e.campaign_id
  ),
  conversion_totals AS MATERIALIZED (
    SELECT x.campaign_id,
      count(*) AS sales,
      COALESCE(sum(x.gross_cents), 0) AS gross_cents,
      COALESCE(sum(x.platform_share_cents), 0) AS platform_cents
    FROM public.shadow_boost_conversions x
    JOIN scope c ON c.id = x.campaign_id
    WHERE x.verified_at >= v_from AND x.verified_at < v_until
    GROUP BY x.campaign_id
  ),
  progress_base AS MATERIALIZED (
    SELECT c.*,
      COALESCE(e.impressions, 0) AS impressions,
      COALESCE(e.reach, 0) AS reach,
      COALESCE(e.clicks, 0) AS clicks,
      COALESCE(e.engagements, 0) AS engagements,
      COALESCE(e.followers, 0) AS followers,
      COALESCE(e.opens, 0) AS opens,
      COALESCE(e.reads, 0) AS reads,
      COALESCE(e.unlocks, 0) AS unlocks,
      COALESCE(v.sales, 0) AS sales,
      COALESCE(v.gross_cents, 0) AS gross_cents,
      COALESCE(v.platform_cents, 0) AS platform_cents,
      CASE WHEN c.fee_verified_at >= v_from AND c.fee_verified_at < v_until THEN c.fee_paid_cents ELSE 0 END AS period_fee_cents,
      CASE c.goal_kind
        WHEN 'reach' THEN COALESCE(e.reach, 0)
        WHEN 'clicks' THEN COALESCE(e.clicks, 0)
        WHEN 'engagements' THEN COALESCE(e.engagements, 0)
        WHEN 'followers' THEN COALESCE(e.followers, 0)
        WHEN 'opens' THEN COALESCE(e.opens, 0)
        WHEN 'reads' THEN COALESCE(e.reads, 0)
        WHEN 'unlocks' THEN COALESCE(e.unlocks, 0)
        WHEN 'sales' THEN COALESCE(v.sales, 0)
        ELSE 0
      END AS goal_value
    FROM scope c
    LEFT JOIN event_totals e ON e.campaign_id = c.id
    LEFT JOIN conversion_totals v ON v.campaign_id = c.id
  ),
  performance AS MATERIALIZED (
    SELECT b.*,
      CASE WHEN b.goal_target > 0
        THEN ROUND(LEAST(100::numeric, b.goal_value * 100.0 / b.goal_target), 1)
        ELSE 0::numeric
      END AS goal_achieved_percent
    FROM progress_base b
  ),
  daily_impressions AS (
    SELECT e.event_day, count(*) AS total
    FROM public.shadow_boost_events e
    JOIN scope c ON c.id = e.campaign_id
    WHERE e.event_kind = 'impression'
      AND e.event_day BETWEEN GREATEST(p_start, p_end - 30) AND p_end
    GROUP BY e.event_day
  ),
  filtered AS MATERIALIZED (
    SELECT * FROM performance c
    WHERE v_search = '' OR strpos(lower(c.title), lower(v_search)) > 0 OR strpos(lower(c.author_name), lower(v_search)) > 0
  )
  SELECT jsonb_build_object(
    'metrics', (
      SELECT jsonb_build_object(
        'boost_revenue', COALESCE(sum(period_fee_cents), 0) / 100.0,
        'active_campaigns', count(*) FILTER (WHERE status = 'active' AND starts_at < v_until AND ends_at >= v_from),
        'reach', COALESCE(sum(reach), 0),
        'goals_achieved_percent', CASE WHEN COALESCE(sum(goal_target) FILTER (WHERE goal_target > 0), 0) > 0
          THEN ROUND(
            100.0 * COALESCE(sum(LEAST(goal_value, goal_target)) FILTER (WHERE goal_target > 0), 0)
            / sum(goal_target) FILTER (WHERE goal_target > 0), 1
          )
          ELSE 0::numeric
        END
      ) FROM performance
    ),
    'revenue', (
      SELECT jsonb_build_object(
        'boost_fees', COALESCE(sum(period_fee_cents), 0) / 100.0,
        'attributed_sales', COALESCE(sum(gross_cents), 0) / 100.0,
        'shadow_share', COALESCE(sum(platform_cents), 0) / 100.0,
        'platform_revenue', (COALESCE(sum(period_fee_cents), 0) + COALESCE(sum(platform_cents), 0)) / 100.0
      ) FROM performance
    ),
    'funnel', (
      SELECT jsonb_build_object(
        'impressions', COALESCE(sum(impressions), 0),
        'clicks', COALESCE(sum(clicks), 0),
        'engagements', COALESCE(sum(engagements), 0),
        'followers', COALESCE(sum(followers), 0),
        'opens', COALESCE(sum(opens), 0),
        'reads', COALESCE(sum(reads), 0),
        'unlocks', COALESCE(sum(unlocks), 0)
      ) FROM performance
    ),
    'trend', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('day', d.day::date::text, 'value', COALESCE(t.total, 0)) ORDER BY d.day)
      FROM generate_series(GREATEST(p_start, p_end - 30)::timestamp, p_end::timestamp, interval '1 day') AS d(day)
      LEFT JOIN daily_impressions t ON t.event_day = d.day::date
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'campaigns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id,
        'title', c.title,
        'author_name', c.author_name,
        'cover_url', c.cover_url,
        'placement', c.placement,
        'goal', initcap(c.goal_kind) || ' ' || c.goal_target::text,
        'goal_achieved_percent', c.goal_achieved_percent,
        'boost_fee', c.period_fee_cents / 100.0,
        'attributed_revenue', c.gross_cents / 100.0,
        'status', c.status
      ) ORDER BY c.created_at DESC, c.id DESC)
      FROM (
        SELECT * FROM filtered
        ORDER BY created_at DESC, id DESC
        LIMIT p_limit OFFSET ((p_page - 1) * p_limit)
      ) c
    ), '[]'::jsonb)
  ) INTO v_report;

  RETURN v_report;
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_shadow_boost_analytics()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reader_removed integer := 0;
  v_boost_removed integer := 0;
  v_cutoff date := (now() AT TIME ZONE 'Asia/Phnom_Penh')::date - 365;
BEGIN
  WITH old_rows AS (
    SELECT id FROM public.shadow_reader_interest_events
    WHERE event_day < v_cutoff
    ORDER BY event_day, id
    LIMIT 5000
  )
  DELETE FROM public.shadow_reader_interest_events e
  USING old_rows o WHERE e.id = o.id;
  GET DIAGNOSTICS v_reader_removed = ROW_COUNT;

  WITH old_rows AS (
    SELECT id FROM public.shadow_boost_events
    WHERE event_day < v_cutoff
    ORDER BY event_day, id
    LIMIT 5000
  )
  DELETE FROM public.shadow_boost_events e
  USING old_rows o WHERE e.id = o.id;
  GET DIAGNOSTICS v_boost_removed = ROW_COUNT;

  RETURN jsonb_build_object(
    'reader_interest_deleted', v_reader_removed,
    'boost_events_deleted', v_boost_removed,
    'max_rows_per_table', 5000,
    'cutoff', v_cutoff
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_shadow_boost_reader_insights(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_shadow_boost_author_insights(text, date, date, integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_shadow_boost_analytics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shadow_boost_reader_insights(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_shadow_boost_author_insights(text, date, date, integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_shadow_boost_analytics() TO service_role;
