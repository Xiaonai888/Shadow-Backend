BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.discover_promotion_language_rotation_v1') IS NULL THEN
    RAISE EXCEPTION 'MISSING_TABLE: Run sql/discover_promotion_language_rotation_v1.sql first';
  END IF;
  IF to_regprocedure('public.get_or_rotate_discover_special_promotions_language_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'MISSING_STORY_FUNCTION: Run sql/discover_promotion_language_rotation_v1.sql first';
  END IF;
  IF to_regprocedure('public.get_or_rotate_discover_author_store_promotions_language_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'MISSING_PDF_FUNCTION: Run sql/discover_promotion_language_rotation_v1.sql first';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.get_or_rotate_discover_special_promotions_language_v1(text)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.get_or_rotate_discover_author_store_promotions_language_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SERVICE_ROLE_PERMISSION_MISSING';
  END IF;
  IF has_function_privilege('anon', 'public.get_or_rotate_discover_special_promotions_language_v1(text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.get_or_rotate_discover_author_store_promotions_language_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ANON_EXECUTE_PERMISSION_UNEXPECTED';
  END IF;
END;
$preflight$;

WITH targets(kind, language) AS (
  VALUES
    ('story', 'km'), ('story', 'en'), ('story', 'zh'),
    ('story', 'ja'), ('story', 'ko'), ('pdf', 'km')
),
first_calls AS MATERIALIZED (
  SELECT
    t.kind,
    t.language,
    CASE WHEN t.kind = 'story'
      THEN public.get_or_rotate_discover_special_promotions_language_v1(t.language)
      ELSE public.get_or_rotate_discover_author_store_promotions_language_v1(t.language)
    END AS data
  FROM targets t
),
second_calls AS MATERIALIZED (
  SELECT
    f.*,
    CASE WHEN f.kind = 'story'
      THEN public.get_or_rotate_discover_special_promotions_language_v1(f.language)
      ELSE public.get_or_rotate_discover_author_store_promotions_language_v1(f.language)
    END AS repeated_data
  FROM first_calls f
),
checks AS (
  SELECT
    r.kind,
    r.language,
    jsonb_array_length(r.data->'promotions') AS offers,
    r.data->>'language' = r.language AS correct_language,
    jsonb_array_length(r.data->'promotions') <= 3 AS max_three,
    (r.data->>'expires_at')::timestamptz =
      (r.data->>'slot_start_at')::timestamptz + interval '6 hours' AS six_hour_window,
    (r.data->>'slot_start_at')::timestamptz =
      to_timestamp(floor((extract(epoch FROM clock_timestamp()) + 25200) / 21600) * 21600 - 25200)
      AS cambodia_slot,
    r.data = r.repeated_data AS stable_same_slot,
    coalesce(r.data->'promotion', 'null'::jsonb) =
      coalesce(r.data->'promotions'->0, 'null'::jsonb) AS first_offer_consistent,
    (
      SELECT count(*) = count(DISTINCT offer.item->>
        (CASE WHEN r.kind = 'story' THEN 'story_id' ELSE 'product_id' END))
      FROM jsonb_array_elements(r.data->'promotions') AS offer(item)
    ) AS unique_offers,
    NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(r.data->'promotions') AS offer(item)
      WHERE CASE WHEN r.kind = 'story' THEN
        offer.item->>'story_language' IS DISTINCT FROM r.language
        OR nullif(offer.item->>'story_id', '') IS NULL
        OR coalesce((offer.item->>'locked_episode_count')::integer, 0) < 5
        OR coalesce((offer.item->>'discount_percent')::integer, -1) <> 50
        OR coalesce((offer.item->>'original_price_diamonds')::numeric, 0) < 10
        OR coalesce((offer.item->>'discounted_price_diamonds')::numeric, 0) <>
          ceil(coalesce((offer.item->>'original_price_diamonds')::numeric, 0) / 2)
        OR (offer.item->>'expires_at')::timestamptz <>
          (r.data->>'expires_at')::timestamptz
      ELSE
        offer.item->>'story_language' IS DISTINCT FROM 'km'
        OR offer.item->>'product_type' IS DISTINCT FROM 'pdf'
        OR nullif(offer.item->>'product_id', '') IS NULL
        OR nullif(offer.item->>'author_page_id', '') IS NULL
        OR coalesce((offer.item->>'original_price_usd')::numeric, 0) <
           coalesce((offer.item->>'author_price_usd')::numeric, 0)
        OR coalesce((offer.item->>'author_price_usd')::numeric, 0) < 0.01
        OR coalesce((offer.item->>'promotion_price_usd')::numeric, 0) < 0.01
        OR coalesce((offer.item->>'promotion_price_usd')::numeric, 0) >
          coalesce((offer.item->>'author_price_usd')::numeric, 0)
        OR coalesce((offer.item->>'promotion_price_usd')::numeric, 0) >
          greatest(0.01::numeric,
            trunc(coalesce((offer.item->>'original_price_usd')::numeric, 0) * 0.8, 2))
        OR (offer.item->>'expires_at')::timestamptz <>
          (r.data->>'expires_at')::timestamptz
      END
    ) AS valid_offer_details
  FROM second_calls r
)
SELECT
  kind,
  language,
  offers,
  correct_language,
  max_three,
  six_hour_window,
  cambodia_slot,
  stable_same_slot,
  first_offer_consistent,
  unique_offers,
  valid_offer_details,
  CASE WHEN
    correct_language AND max_three AND six_hour_window
    AND cambodia_slot AND stable_same_slot AND first_offer_consistent
    AND unique_offers AND valid_offer_details
  THEN 'PASS' ELSE 'FAIL' END AS result
FROM checks
ORDER BY kind, language;

ROLLBACK;
