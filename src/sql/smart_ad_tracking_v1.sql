BEGIN;

CREATE TABLE IF NOT EXISTS public.smart_ad_reader_exposure (
  reader_hash text NOT NULL CHECK (reader_hash ~ '^[0-9a-f]{64}$'),
  slot_key text NOT NULL CHECK (slot_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T(00|06|12|18):00$'),
  story_id uuid NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  first_placement text NOT NULL CHECK (first_placement IN ('discover', 'opening', 'freeUnlock', 'me')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  clicked_at timestamptz,
  PRIMARY KEY (reader_hash, slot_key, story_id)
);

CREATE INDEX IF NOT EXISTS smart_ad_reader_exposure_age_idx
ON public.smart_ad_reader_exposure (first_seen_at);

CREATE TABLE IF NOT EXISTS public.smart_ad_story_exposure_totals (
  story_id uuid PRIMARY KEY REFERENCES public.stories(id) ON DELETE CASCADE,
  impressions bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.smart_ad_reader_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_ad_story_exposure_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.smart_ad_reader_exposure FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.smart_ad_story_exposure_totals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.smart_ad_reader_exposure TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.smart_ad_story_exposure_totals TO service_role;

CREATE OR REPLACE FUNCTION public.smart_ad_record_events_v1(
  p_reader_hash text,
  p_slot_key text,
  p_placement text,
  p_event_type text,
  p_story_ids uuid[]
)
RETURNS TABLE (accepted_count integer, new_impressions integer, new_clicks integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  v_story_id uuid;
  v_was_inserted boolean;
  v_clicked_now boolean;
  v_view_increment integer;
  v_click_increment integer;
  v_accepted integer := 0;
  v_views integer := 0;
  v_clicks integer := 0;
BEGIN
  IF p_reader_hash IS NULL OR p_reader_hash !~ '^[0-9a-f]{64}$'
    OR p_slot_key IS NULL OR p_slot_key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T(00|06|12|18):00$'
    OR p_placement NOT IN ('discover', 'opening', 'freeUnlock', 'me')
    OR p_event_type NOT IN ('impression', 'click')
    OR p_story_ids IS NULL OR cardinality(p_story_ids) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Invalid Smart Ad tracking request';
  END IF;

  FOR v_story_id IN SELECT DISTINCT unnest(p_story_ids) LOOP
    IF v_story_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.smart_ad_active_pool p WHERE p.story_id = v_story_id
    ) THEN
      CONTINUE;
    END IF;

    v_was_inserted := false;
    v_clicked_now := false;
    v_view_increment := 0;
    v_click_increment := 0;

    INSERT INTO public.smart_ad_reader_exposure (
      reader_hash, slot_key, story_id, first_placement, clicked_at
    ) VALUES (
      p_reader_hash, p_slot_key, v_story_id, p_placement,
      CASE WHEN p_event_type = 'click' THEN now() ELSE NULL END
    )
    ON CONFLICT (reader_hash, slot_key, story_id) DO NOTHING
    RETURNING true INTO v_was_inserted;

    IF COALESCE(v_was_inserted, false) THEN
      v_view_increment := 1;
      IF p_event_type = 'click' THEN v_click_increment := 1; END IF;
    ELSIF p_event_type = 'click' THEN
      UPDATE public.smart_ad_reader_exposure e
      SET clicked_at = now()
      WHERE e.reader_hash = p_reader_hash
        AND e.slot_key = p_slot_key
        AND e.story_id = v_story_id
        AND e.clicked_at IS NULL
      RETURNING true INTO v_clicked_now;
      IF COALESCE(v_clicked_now, false) THEN v_click_increment := 1; END IF;
    END IF;

    IF v_view_increment > 0 OR v_click_increment > 0 THEN
      INSERT INTO public.smart_ad_story_exposure_totals (
        story_id, impressions, clicks, updated_at
      ) VALUES (v_story_id, v_view_increment, v_click_increment, now())
      ON CONFLICT (story_id) DO UPDATE
      SET impressions = public.smart_ad_story_exposure_totals.impressions + EXCLUDED.impressions,
          clicks = public.smart_ad_story_exposure_totals.clicks + EXCLUDED.clicks,
          updated_at = now();
    END IF;

    v_accepted := v_accepted + 1;
    v_views := v_views + v_view_increment;
    v_clicks := v_clicks + v_click_increment;
  END LOOP;

  RETURN QUERY SELECT v_accepted, v_views, v_clicks;
END;
$$;

REVOKE ALL ON FUNCTION public.smart_ad_record_events_v1(text, text, text, text, uuid[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_ad_record_events_v1(text, text, text, text, uuid[])
TO service_role;

CREATE OR REPLACE FUNCTION public.smart_ad_prune_exposure_v1(p_batch_size integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Invalid Smart Ad pruning batch size';
  END IF;
  DELETE FROM public.smart_ad_reader_exposure e
  WHERE e.ctid IN (
    SELECT stale.ctid
    FROM public.smart_ad_reader_exposure stale
    WHERE stale.first_seen_at < now() - interval '30 days'
    ORDER BY stale.first_seen_at ASC
    LIMIT p_batch_size
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.smart_ad_prune_exposure_v1(integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_ad_prune_exposure_v1(integer) TO service_role;

COMMIT;
