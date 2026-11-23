CREATE TABLE IF NOT EXISTS public.smart_pdf_reader_exposure (
  reader_hash text NOT NULL CHECK (reader_hash ~ '^[0-9a-f]{64}$'),
  product_id uuid NOT NULL REFERENCES public.author_store_products(id) ON DELETE CASCADE,
  slot_key text NOT NULL CHECK (slot_key ~ '^[0-9]{9,12}$'),
  placement text NOT NULL CHECK (placement IN ('stories', 'manga', 'discover')),
  impressions integer NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks integer NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reader_hash, product_id, slot_key)
);

CREATE INDEX IF NOT EXISTS smart_pdf_reader_exposure_recent_idx
  ON public.smart_pdf_reader_exposure (reader_hash, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.smart_pdf_product_exposure_totals (
  product_id uuid PRIMARY KEY REFERENCES public.author_store_products(id) ON DELETE CASCADE,
  impressions bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.smart_pdf_reader_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_pdf_product_exposure_totals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.smart_pdf_reader_exposure FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.smart_pdf_product_exposure_totals FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.smart_pdf_record_events_v1(
  p_reader_hash text,
  p_slot_key text,
  p_placement text,
  p_event_type text,
  p_product_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id uuid;
  v_count integer := 0;
  v_new_impressions integer := 0;
  v_new_clicks integer := 0;
  v_changed integer;
BEGIN
  IF p_reader_hash IS NULL OR p_reader_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid PDF reader identity';
  END IF;
  IF p_slot_key IS NULL OR p_slot_key !~ '^[0-9]{9,12}$' THEN
    RAISE EXCEPTION 'Invalid PDF promotion slot';
  END IF;
  IF p_placement IS NULL OR p_placement NOT IN ('stories', 'manga', 'discover') THEN
    RAISE EXCEPTION 'Invalid PDF placement';
  END IF;
  IF p_event_type IS NULL OR p_event_type NOT IN ('impression', 'click') THEN
    RAISE EXCEPTION 'Invalid PDF event';
  END IF;
  IF p_product_ids IS NULL OR cardinality(p_product_ids) < 1 OR cardinality(p_product_ids) > 10 THEN
    RAISE EXCEPTION 'Expected 1-10 PDF products';
  END IF;
  IF array_position(p_product_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid PDF product';
  END IF;

  FOR v_product_id IN SELECT DISTINCT unnest(p_product_ids) LOOP
    v_count := v_count + 1;
    INSERT INTO public.smart_pdf_reader_exposure (
      reader_hash, product_id, slot_key, placement, impressions, clicks
    ) VALUES (
      p_reader_hash, v_product_id, p_slot_key, p_placement, 1, 0
    )
    ON CONFLICT (reader_hash, product_id, slot_key) DO NOTHING;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed = 1 THEN
      v_new_impressions := v_new_impressions + 1;
      INSERT INTO public.smart_pdf_product_exposure_totals (product_id, impressions, clicks)
      VALUES (v_product_id, 1, 0)
      ON CONFLICT (product_id) DO UPDATE
        SET impressions = smart_pdf_product_exposure_totals.impressions + 1,
            updated_at = now();
    END IF;

    IF p_event_type = 'click' THEN
      UPDATE public.smart_pdf_reader_exposure
      SET clicks = 1, last_seen_at = now()
      WHERE reader_hash = p_reader_hash AND product_id = v_product_id
        AND slot_key = p_slot_key AND clicks = 0;
      GET DIAGNOSTICS v_changed = ROW_COUNT;
      IF v_changed = 1 THEN
        v_new_clicks := v_new_clicks + 1;
        INSERT INTO public.smart_pdf_product_exposure_totals (product_id, impressions, clicks)
        VALUES (v_product_id, 0, 1)
        ON CONFLICT (product_id) DO UPDATE
          SET clicks = smart_pdf_product_exposure_totals.clicks + 1,
              updated_at = now();
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'accepted_count', v_count,
    'new_impressions', v_new_impressions,
    'new_clicks', v_new_clicks
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.smart_pdf_prune_exposure_v1()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.smart_pdf_reader_exposure
  WHERE last_seen_at < now() - interval '8 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.smart_pdf_record_events_v1(text, text, text, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_pdf_record_events_v1(text, text, text, text, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.smart_pdf_prune_exposure_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smart_pdf_prune_exposure_v1() TO service_role;
