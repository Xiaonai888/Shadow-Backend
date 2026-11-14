CREATE TABLE IF NOT EXISTS public.discover_promotion_language_rotation_v1 (
  kind text NOT NULL CHECK (kind IN ('story', 'store')),
  story_language text NOT NULL CHECK (story_language IN ('km', 'en', 'zh', 'ja', 'ko')),
  slot_start_at timestamptz NOT NULL DEFAULT to_timestamp(0),
  expires_at timestamptz NOT NULL DEFAULT to_timestamp(0),
  promotions jsonb NOT NULL DEFAULT '[]'::jsonb,
  used_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  rotation_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, story_language)
);

ALTER TABLE public.discover_promotion_language_rotation_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discover_promotion_language_rotation_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.discover_promotion_language_rotation_v1 TO service_role;

CREATE OR REPLACE FUNCTION public.get_or_rotate_discover_special_promotions_language_v1(p_language text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_language text;
  v_language_name text;
  v_now timestamptz := clock_timestamp();
  v_slot_start timestamptz;
  v_expires_at timestamptz;
  v_state public.discover_promotion_language_rotation_v1%ROWTYPE;
  v_candidates jsonb := '[]'::jsonb;
  v_promotions jsonb := '[]'::jsonb;
  v_choice jsonb;
  v_used_ids text[] := ARRAY[]::text[];
  v_previous_ids text[] := ARRAY[]::text[];
  v_selected_ids text[] := ARRAY[]::text[];
  v_total integer := 0;
  v_position integer;
  v_rate numeric;
  v_original numeric;
BEGIN
  v_language := CASE lower(btrim(coalesce(p_language, '')))
    WHEN 'km' THEN 'km' WHEN 'khmer' THEN 'km'
    WHEN 'en' THEN 'en' WHEN 'english' THEN 'en'
    WHEN 'zh' THEN 'zh' WHEN 'chinese' THEN 'zh'
    WHEN 'ja' THEN 'ja' WHEN 'japanese' THEN 'ja'
    WHEN 'ko' THEN 'ko' WHEN 'korean' THEN 'ko'
    ELSE NULL
  END;
  IF v_language IS NULL THEN
    RAISE EXCEPTION 'INVALID_STORY_LANGUAGE';
  END IF;

  v_language_name := CASE v_language
    WHEN 'km' THEN 'khmer'
    WHEN 'en' THEN 'english'
    WHEN 'zh' THEN 'chinese'
    WHEN 'ja' THEN 'japanese'
    WHEN 'ko' THEN 'korean'
  END;

  PERFORM pg_advisory_xact_lock(26577, hashtext('story:' || v_language));
  v_slot_start := to_timestamp(floor((extract(epoch FROM v_now) + 25200) / 21600) * 21600 - 25200);
  v_expires_at := v_slot_start + interval '6 hours';

  INSERT INTO public.discover_promotion_language_rotation_v1 (kind, story_language)
  VALUES ('story', v_language)
  ON CONFLICT (kind, story_language) DO NOTHING;

  SELECT * INTO v_state
  FROM public.discover_promotion_language_rotation_v1
  WHERE kind = 'story' AND story_language = v_language
  FOR UPDATE;

  IF v_state.slot_start_at = v_slot_start AND v_state.expires_at = v_expires_at THEN
    RETURN jsonb_build_object(
      'promotions', v_state.promotions,
      'promotion', v_state.promotions -> 0,
      'slot_start_at', v_state.slot_start_at,
      'expires_at', v_state.expires_at,
      'rotation_key', extract(epoch FROM v_slot_start)::bigint,
      'language', v_language
    );
  END IF;

  SELECT diamond_per_episode INTO v_rate
  FROM public.platform_unlock_rules
  WHERE id = 1;
  v_rate := coalesce(v_rate, 10);
  IF v_rate < 2 OR v_rate <> trunc(v_rate) THEN
    RAISE EXCEPTION 'INVALID_DIAMOND_PRICE';
  END IF;

  WITH published AS (
    SELECT
      s.id::text AS story_id,
      s.title AS story_title,
      coalesce(s.description, '') AS description,
      s.cover_url,
      e.is_locked,
      e.is_free_published,
      row_number() OVER (
        PARTITION BY s.id
        ORDER BY coalesce(e.first_published_at, to_timestamp(0)),
          e.episode_number, e.created_at, e.id
      ) AS published_rank
    FROM public.stories AS s
    JOIN public.author_pages AS a ON a.id = s.author_id
    JOIN public.episodes AS e ON e.story_id = s.id
    WHERE s.status = 'published'
      AND s.deleted_at IS NULL
      AND coalesce(s.total_episodes, 0) >= 10
      AND (s.admin_visibility_status IS NULL OR s.admin_visibility_status = 'active')
      AND coalesce(s.is_adult, false) = false
      AND coalesce(s.is_shadow_exclusive, false) = false
      AND a.status = 'active'
      AND (a.admin_status IS NULL OR a.admin_status = 'active')
      AND s.title IS NOT NULL
      AND nullif(btrim(s.cover_url), '') IS NOT NULL
      AND lower(btrim(coalesce(s.story_language, ''))) IN (v_language, v_language_name)
      AND e.status = 'published'
      AND e.deleted_at IS NULL
      AND (e.first_published_at IS NULL OR e.first_published_at <= v_now)
  ), totals AS (
    SELECT
      story_id, story_title, description, cover_url,
      count(*)::integer AS total_episodes,
      count(*) FILTER (
        WHERE coalesce(is_locked, false)
          AND NOT coalesce(is_free_published, false)
          AND published_rank > 5
      )::integer AS locked_episode_count
    FROM published
    GROUP BY story_id, story_title, description, cover_url
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'story_id', story_id,
    'story_title', story_title,
    'description', description,
    'cover_url', cover_url,
    'profile_image_url', cover_url,
    'locked_episode_count', locked_episode_count,
    'total_episodes', total_episodes,
    'story_language', v_language
  )), '[]'::jsonb)
  INTO v_candidates
  FROM totals
  WHERE locked_episode_count >= 5;

  v_total := jsonb_array_length(v_candidates);
  v_used_ids := coalesce(v_state.used_ids, ARRAY[]::text[]);
  v_previous_ids := coalesce(v_state.last_ids, ARRAY[]::text[]);

  FOR v_position IN 1..least(3, v_total) LOOP
    v_choice := NULL;

    SELECT item.value INTO v_choice
    FROM jsonb_array_elements(v_candidates) AS item(value)
    WHERE NOT ((item.value->>'story_id') = ANY(v_used_ids))
      AND NOT ((item.value->>'story_id') = ANY(v_selected_ids))
    ORDER BY md5((item.value->>'story_id') || v_slot_start::text || v_language || v_position::text)
    LIMIT 1;

    IF v_choice IS NULL THEN
      v_used_ids := v_selected_ids;

      SELECT item.value INTO v_choice
      FROM jsonb_array_elements(v_candidates) AS item(value)
      WHERE NOT ((item.value->>'story_id') = ANY(v_selected_ids))
      ORDER BY
        CASE WHEN v_total > 3 AND (item.value->>'story_id') = ANY(v_previous_ids) THEN 1 ELSE 0 END,
        md5((item.value->>'story_id') || v_slot_start::text || v_language || v_position::text)
      LIMIT 1;
    END IF;

    EXIT WHEN v_choice IS NULL;

    v_selected_ids := array_append(v_selected_ids, v_choice->>'story_id');
    v_used_ids := array_append(v_used_ids, v_choice->>'story_id');
    v_original := (v_choice->>'locked_episode_count')::integer * v_rate;

    v_promotions := v_promotions || jsonb_build_array(
      v_choice || jsonb_build_object(
        'id', 'special-' || (v_choice->>'story_id'),
        'original_price_diamonds', v_original::integer,
        'discounted_price_diamonds', ceil(v_original / 2)::integer,
        'discount_percent', 50,
        'slot_start_at', v_slot_start,
        'expires_at', v_expires_at
      )
    );
  END LOOP;

  UPDATE public.discover_promotion_language_rotation_v1
  SET slot_start_at = v_slot_start,
      expires_at = v_expires_at,
      promotions = v_promotions,
      used_ids = v_used_ids,
      last_ids = v_selected_ids,
      rotation_count = v_state.rotation_count + 1,
      updated_at = v_now
  WHERE kind = 'story' AND story_language = v_language;

  RETURN jsonb_build_object(
    'promotions', v_promotions,
    'promotion', v_promotions -> 0,
    'slot_start_at', v_slot_start,
    'expires_at', v_expires_at,
    'rotation_key', extract(epoch FROM v_slot_start)::bigint,
    'language', v_language
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_rotate_discover_special_promotions_language_v1(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_rotate_discover_special_promotions_language_v1(text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_or_rotate_discover_author_store_promotions_language_v1(p_language text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_language text;
  v_language_name text;
  v_now timestamptz := clock_timestamp();
  v_slot_start timestamptz;
  v_expires_at timestamptz;
  v_state public.discover_promotion_language_rotation_v1%ROWTYPE;
  v_candidates jsonb := '[]'::jsonb;
  v_promotions jsonb := '[]'::jsonb;
  v_used_ids text[] := ARRAY[]::text[];
  v_previous_ids text[] := ARRAY[]::text[];
  v_selected_ids text[] := ARRAY[]::text[];
  v_choice jsonb;
  v_total integer := 0;
  v_position integer;
BEGIN
  v_language := CASE lower(btrim(coalesce(p_language, '')))
    WHEN 'km' THEN 'km' WHEN 'khmer' THEN 'km'
    WHEN 'en' THEN 'en' WHEN 'english' THEN 'en'
    WHEN 'zh' THEN 'zh' WHEN 'chinese' THEN 'zh'
    WHEN 'ja' THEN 'ja' WHEN 'japanese' THEN 'ja'
    WHEN 'ko' THEN 'ko' WHEN 'korean' THEN 'ko'
    ELSE NULL
  END;
  IF v_language IS NULL THEN
    RAISE EXCEPTION 'INVALID_STORY_LANGUAGE';
  END IF;

  v_language_name := CASE v_language
    WHEN 'km' THEN 'khmer'
    WHEN 'en' THEN 'english'
    WHEN 'zh' THEN 'chinese'
    WHEN 'ja' THEN 'japanese'
    WHEN 'ko' THEN 'korean'
  END;

  PERFORM pg_advisory_xact_lock(26577, hashtext('pdf:' || v_language));
  v_slot_start := to_timestamp(floor((extract(epoch FROM v_now) + 25200) / 21600) * 21600 - 25200);
  v_expires_at := v_slot_start + interval '6 hours';

  INSERT INTO public.discover_promotion_language_rotation_v1 (kind, story_language)
  VALUES ('store', v_language)
  ON CONFLICT (kind, story_language) DO NOTHING;

  SELECT * INTO v_state
  FROM public.discover_promotion_language_rotation_v1
  WHERE kind = 'store' AND story_language = v_language
  FOR UPDATE;

  IF v_state.slot_start_at = v_slot_start AND v_state.expires_at = v_expires_at THEN
    RETURN jsonb_build_object(
      'promotions', v_state.promotions,
      'promotion', v_state.promotions -> 0,
      'slot_start_at', v_state.slot_start_at,
      'expires_at', v_state.expires_at,
      'rotation_key', extract(epoch FROM v_slot_start)::bigint,
      'language', v_language,
      'currency', 'USD'
    );
  END IF;

  WITH source_products AS (
    SELECT
      p.id::text AS product_id,
      p.author_page_id::text AS author_page_id,
      a.page_username, a.page_name,
      p.product_type, p.title,
      coalesce(p.author_name, '') AS author_name,
      coalesce(p.description, '') AS description,
      p.cover_url,
      coalesce(p.original_price, 0)::numeric AS original_price,
      CASE WHEN coalesce(p.sale_price, 0) > 0
        THEN p.sale_price::numeric
        ELSE coalesce(p.original_price, 0)::numeric
      END AS author_price
    FROM public.author_store_products AS p
    JOIN public.author_pages AS a ON a.id = p.author_page_id
    WHERE p.status = 'active'
      AND p.product_type = 'pdf'
      AND a.status = 'active'
      AND (a.admin_status IS NULL OR a.admin_status = 'active')
      AND nullif(btrim(a.page_username), '') IS NOT NULL
      AND nullif(btrim(p.title), '') IS NOT NULL
      AND nullif(btrim(p.cover_url), '') IS NOT NULL
      AND lower(btrim(coalesce(p.novel_type, ''))) IN (v_language, v_language_name)
  ), prices AS (
    SELECT
      s.*,
      greatest(s.author_price, s.original_price) AS reference_price
    FROM source_products AS s
    WHERE s.author_price > 0
  ), offers AS (
    SELECT
      p.*,
      least(
        p.author_price,
        greatest(0.01::numeric, trunc(p.reference_price * 0.80, 2))
      ) AS promotion_price
    FROM prices AS p
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', 'author-store-' || o.product_id,
    'product_id', o.product_id,
    'author_page_id', o.author_page_id,
    'page_username', o.page_username,
    'page_name', o.page_name,
    'product_type', 'pdf',
    'title', o.title,
    'author_name', o.author_name,
    'description', o.description,
    'cover_url', o.cover_url,
    'profile_image_url', o.cover_url,
    'stock_quantity', NULL,
    'pre_order', false,
    'currency', 'USD',
    'original_price_usd', round(o.reference_price, 2),
    'author_price_usd', round(o.author_price, 2),
    'promotion_price_usd', round(o.promotion_price, 2),
    'discount_percent', round((o.reference_price - o.promotion_price) * 100 / o.reference_price)::integer,
    'discount_source', CASE
      WHEN o.promotion_price >= o.reference_price THEN 'none'
      WHEN o.author_price <= o.promotion_price THEN 'author'
      ELSE 'admin'
    END,
    'story_language', v_language
  )), '[]'::jsonb)
  INTO v_candidates
  FROM offers AS o
  WHERE o.promotion_price > 0;

  v_total := jsonb_array_length(v_candidates);
  v_used_ids := coalesce(v_state.used_ids, ARRAY[]::text[]);
  v_previous_ids := coalesce(v_state.last_ids, ARRAY[]::text[]);

  FOR v_position IN 1..least(3, v_total) LOOP
    v_choice := NULL;

    SELECT item.value INTO v_choice
    FROM jsonb_array_elements(v_candidates) AS item(value)
    WHERE NOT ((item.value->>'product_id') = ANY(v_used_ids))
      AND NOT ((item.value->>'product_id') = ANY(v_selected_ids))
    ORDER BY md5((item.value->>'product_id') || v_slot_start::text || v_language || v_position::text)
    LIMIT 1;

    IF v_choice IS NULL THEN
      v_used_ids := v_selected_ids;

      SELECT item.value INTO v_choice
      FROM jsonb_array_elements(v_candidates) AS item(value)
      WHERE NOT ((item.value->>'product_id') = ANY(v_selected_ids))
      ORDER BY
        CASE WHEN v_total > 3 AND (item.value->>'product_id') = ANY(v_previous_ids) THEN 1 ELSE 0 END,
        md5((item.value->>'product_id') || v_slot_start::text || v_language || v_position::text)
      LIMIT 1;
    END IF;

    EXIT WHEN v_choice IS NULL;

    v_selected_ids := array_append(v_selected_ids, v_choice->>'product_id');
    v_used_ids := array_append(v_used_ids, v_choice->>'product_id');

    v_promotions := v_promotions || jsonb_build_array(
      v_choice || jsonb_build_object(
        'slot_position', v_position,
        'slot_start_at', v_slot_start,
        'expires_at', v_expires_at
      )
    );
  END LOOP;

  UPDATE public.discover_promotion_language_rotation_v1
  SET slot_start_at = v_slot_start,
      expires_at = v_expires_at,
      promotions = v_promotions,
      used_ids = v_used_ids,
      last_ids = v_selected_ids,
      rotation_count = v_state.rotation_count + 1,
      updated_at = v_now
  WHERE kind = 'store' AND story_language = v_language;

  RETURN jsonb_build_object(
    'promotions', v_promotions,
    'promotion', v_promotions -> 0,
    'slot_start_at', v_slot_start,
    'expires_at', v_expires_at,
    'rotation_key', extract(epoch FROM v_slot_start)::bigint,
    'language', v_language,
    'currency', 'USD'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_rotate_discover_author_store_promotions_language_v1(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_rotate_discover_author_store_promotions_language_v1(text) TO service_role;
