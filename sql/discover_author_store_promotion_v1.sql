CREATE TABLE IF NOT EXISTS public.discover_author_store_promotion_rotation (
  id smallint PRIMARY KEY CHECK (id = 1),
  slot_start_at timestamptz NOT NULL DEFAULT to_timestamp(0),
  expires_at timestamptz NOT NULL DEFAULT to_timestamp(0),
  promotions jsonb NOT NULL DEFAULT '[]'::jsonb,
  used_book_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  used_pdf_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_product_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  rotation_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.discover_author_store_promotion_rotation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discover_author_store_promotion_rotation FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.discover_author_store_promotion_rotation TO service_role;

CREATE INDEX IF NOT EXISTS idx_author_store_discover_promotion_candidates
  ON public.author_store_products (product_type, author_page_id)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.get_or_rotate_discover_author_store_promotions_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_slot_start timestamptz;
  v_expires_at timestamptz;
  v_state public.discover_author_store_promotion_rotation%ROWTYPE;
  v_candidates jsonb := '[]'::jsonb;
  v_promotions jsonb := '[]'::jsonb;
  v_used_book_ids text[] := ARRAY[]::text[];
  v_used_pdf_ids text[] := ARRAY[]::text[];
  v_previous_ids text[] := ARRAY[]::text[];
  v_selected_ids text[] := ARRAY[]::text[];
  v_choice jsonb;
  v_type text;
  v_total_books integer := 0;
  v_position integer;
  v_used_ids text[];
BEGIN
  PERFORM pg_advisory_xact_lock(26577, 605);

  v_slot_start := to_timestamp(
    floor((extract(epoch FROM v_now) + 25200) / 21600) * 21600 - 25200
  );
  v_expires_at := v_slot_start + interval '6 hours';

  INSERT INTO public.discover_author_store_promotion_rotation (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_state
  FROM public.discover_author_store_promotion_rotation
  WHERE id = 1
  FOR UPDATE;

  IF v_state.slot_start_at = v_slot_start
    AND v_state.expires_at = v_expires_at THEN
    RETURN jsonb_build_object(
      'promotions', v_state.promotions,
      'promotion', v_state.promotions -> 0,
      'slot_start_at', v_state.slot_start_at,
      'expires_at', v_state.expires_at,
      'rotation_key', extract(epoch FROM v_slot_start)::bigint,
      'currency', 'USD'
    );
  END IF;

  WITH source_products AS (
    SELECT
      p.id::text AS product_id,
      p.author_page_id::text AS author_page_id,
      a.page_username,
      a.page_name,
      p.product_type,
      p.title,
      coalesce(p.author_name, '') AS author_name,
      coalesce(p.description, '') AS description,
      p.cover_url,
      coalesce(p.stock_quantity, 0)::integer AS stock_quantity,
      coalesce(p.pre_order, false) AS pre_order,
      coalesce(p.original_price, 0)::numeric AS original_price,
      CASE
        WHEN coalesce(p.sale_price, 0) > 0 THEN p.sale_price::numeric
        ELSE coalesce(p.original_price, 0)::numeric
      END AS author_price
    FROM public.author_store_products AS p
    JOIN public.author_pages AS a ON a.id = p.author_page_id
    WHERE p.status = 'active'
      AND p.product_type IN ('book', 'pdf')
      AND a.status = 'active'
      AND (a.admin_status IS NULL OR a.admin_status = 'active')
      AND nullif(trim(a.page_username), '') IS NOT NULL
      AND nullif(trim(p.title), '') IS NOT NULL
      AND nullif(trim(p.cover_url), '') IS NOT NULL
      AND (
        p.product_type = 'pdf'
        OR (coalesce(p.stock_quantity, 0) > 0 AND coalesce(p.pre_order, false) = false)
      )
  ), prices AS (
    SELECT
      s.*,
      greatest(s.author_price, s.original_price) AS reference_price
    FROM source_products AS s
    WHERE s.author_price > 0
  ), offers AS (
    SELECT
      p.*,
      CASE
        WHEN p.product_type = 'pdf' THEN least(
          p.author_price,
          greatest(0.01::numeric, trunc(p.reference_price * 0.80, 2))
        )
        ELSE p.author_price
      END AS promotion_price
    FROM prices AS p
  )
  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'id', 'author-store-' || o.product_id,
      'product_id', o.product_id,
      'author_page_id', o.author_page_id,
      'page_username', o.page_username,
      'page_name', o.page_name,
      'product_type', o.product_type,
      'title', o.title,
      'author_name', o.author_name,
      'description', o.description,
      'cover_url', o.cover_url,
      'profile_image_url', o.cover_url,
      'stock_quantity', o.stock_quantity,
      'pre_order', o.pre_order,
      'currency', 'USD',
      'original_price_usd', round(o.reference_price, 2),
      'author_price_usd', round(o.author_price, 2),
      'promotion_price_usd', round(o.promotion_price, 2),
      'discount_percent', round((o.reference_price - o.promotion_price) * 100 / o.reference_price)::integer,
      'discount_source', CASE
        WHEN o.promotion_price >= o.reference_price THEN 'none'
        WHEN o.product_type = 'book' THEN 'author'
        WHEN o.author_price <= o.promotion_price THEN 'author'
        ELSE 'admin'
      END
    )),
    '[]'::jsonb
  ) INTO v_candidates
  FROM offers AS o
  WHERE o.promotion_price > 0;

  v_used_book_ids := coalesce(v_state.used_book_ids, ARRAY[]::text[]);
  v_used_pdf_ids := coalesce(v_state.used_pdf_ids, ARRAY[]::text[]);
  v_previous_ids := coalesce(v_state.last_product_ids, ARRAY[]::text[]);

  SELECT count(*) INTO v_total_books
  FROM jsonb_array_elements(v_candidates) AS item(value)
  WHERE item.value->>'product_type' = 'book';

  FOR v_position IN 1..3 LOOP
    v_type := CASE WHEN v_position = 1 AND v_total_books > 0 THEN 'book' ELSE 'pdf' END;
    v_used_ids := CASE WHEN v_type = 'book' THEN v_used_book_ids ELSE v_used_pdf_ids END;
    v_choice := NULL;

    SELECT item.value INTO v_choice
    FROM jsonb_array_elements(v_candidates) AS item(value)
    WHERE item.value->>'product_type' = v_type
      AND NOT ((item.value->>'product_id') = ANY(v_used_ids))
      AND NOT ((item.value->>'product_id') = ANY(v_selected_ids))
    ORDER BY
      md5((item.value->>'product_id') || v_slot_start::text || v_position::text)
    LIMIT 1;

    IF v_choice IS NULL THEN
      v_used_ids := ARRAY[]::text[];

      SELECT item.value INTO v_choice
      FROM jsonb_array_elements(v_candidates) AS item(value)
      WHERE item.value->>'product_type' = v_type
        AND NOT ((item.value->>'product_id') = ANY(v_selected_ids))
      ORDER BY
        CASE WHEN (item.value->>'product_id') = ANY(v_previous_ids) THEN 1 ELSE 0 END,
        md5((item.value->>'product_id') || v_slot_start::text || v_position::text)
      LIMIT 1;
    END IF;

    CONTINUE WHEN v_choice IS NULL;

    v_selected_ids := array_append(v_selected_ids, v_choice->>'product_id');
    v_used_ids := array_append(v_used_ids, v_choice->>'product_id');

    IF v_type = 'book' THEN
      v_used_book_ids := v_used_ids;
    ELSE
      v_used_pdf_ids := v_used_ids;
    END IF;

    v_promotions := v_promotions || jsonb_build_array(
      v_choice || jsonb_build_object(
        'slot_position', v_position,
        'slot_start_at', v_slot_start,
        'expires_at', v_expires_at
      )
    );
  END LOOP;

  UPDATE public.discover_author_store_promotion_rotation
  SET
    slot_start_at = v_slot_start,
    expires_at = v_expires_at,
    promotions = v_promotions,
    used_book_ids = v_used_book_ids,
    used_pdf_ids = v_used_pdf_ids,
    last_product_ids = v_selected_ids,
    rotation_count = v_state.rotation_count + 1,
    updated_at = v_now
  WHERE id = 1;

  RETURN jsonb_build_object(
    'promotions', v_promotions,
    'promotion', v_promotions -> 0,
    'slot_start_at', v_slot_start,
    'expires_at', v_expires_at,
    'rotation_key', extract(epoch FROM v_slot_start)::bigint,
    'currency', 'USD'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_rotate_discover_author_store_promotions_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_rotate_discover_author_store_promotions_v1() TO service_role;

WITH result AS (
  SELECT public.get_or_rotate_discover_author_store_promotions_v1() AS data
)
SELECT
  (data->>'slot_start_at')::timestamptz AT TIME ZONE 'Asia/Phnom_Penh' AS starts_cambodia,
  (data->>'expires_at')::timestamptz AT TIME ZONE 'Asia/Phnom_Penh' AS ends_cambodia,
  jsonb_array_length(data->'promotions') AS product_count,
  (SELECT string_agg(
     concat(p->>'slot_position', '. ', p->>'product_type', ' — ', p->>'title', ' ($', p->>'promotion_price_usd', ')'),
     ' | ' ORDER BY (p->>'slot_position')::integer
   ) FROM jsonb_array_elements(data->'promotions') AS p) AS offers
FROM result;
