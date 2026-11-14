BEGIN;

WITH languages(language) AS (
  VALUES ('km'), ('en'), ('zh'), ('ja'), ('ko')
), rotations AS MATERIALIZED (
  SELECT
    l.language,
    public.get_or_rotate_discover_special_promotions_language_v1(l.language) AS data
  FROM languages l
)
SELECT
  'story' AS promotion_kind,
  r.language,
  r.data->>'language' = r.language AS correct_language,
  jsonb_array_length(r.data->'promotions') AS offer_count,
  jsonb_array_length(r.data->'promotions') <= 3 AS within_limit,
  (r.data->>'expires_at')::timestamptz =
    (r.data->>'slot_start_at')::timestamptz + interval '6 hours' AS six_hour_window,
  NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r.data->'promotions') offer
    WHERE offer->>'story_language' <> r.language
       OR offer->>'story_id' IS NULL
       OR (offer->>'locked_episode_count')::integer < 5
       OR (offer->>'discount_percent')::integer <> 50
       OR (offer->>'discounted_price_diamonds')::integer < 1
  ) AS valid_offers,
  jsonb_array_length(r.data->'promotions') = (
    SELECT count(DISTINCT offer->>'story_id')
    FROM jsonb_array_elements(r.data->'promotions') offer
  ) AS unique_stories
FROM rotations r
ORDER BY r.language;

WITH rotation AS MATERIALIZED (
  SELECT public.get_or_rotate_discover_author_store_promotions_language_v1('km') AS data
)
SELECT
  'store' AS promotion_kind,
  'km' AS language,
  data->>'language' = 'km' AS correct_language,
  jsonb_array_length(data->'promotions') AS offer_count,
  jsonb_array_length(data->'promotions') <= 3 AS within_limit,
  (data->>'expires_at')::timestamptz =
    (data->>'slot_start_at')::timestamptz + interval '6 hours' AS six_hour_window,
  NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(data->'promotions') offer
    WHERE offer->>'product_type' <> 'pdf'
       OR offer->>'story_language' <> 'km'
       OR offer->>'product_id' IS NULL
       OR (offer->>'promotion_price_usd')::numeric <= 0
  ) AS valid_pdf_offers,
  jsonb_array_length(data->'promotions') = (
    SELECT count(DISTINCT offer->>'product_id')
    FROM jsonb_array_elements(data->'promotions') offer
  ) AS unique_products
FROM rotation;

ROLLBACK;
