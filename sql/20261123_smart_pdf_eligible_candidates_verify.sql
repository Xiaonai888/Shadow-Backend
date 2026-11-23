WITH candidates AS (
  SELECT
    p.id,
    CASE p.novel_type
      WHEN 'Khmer' THEN 'km'
      WHEN 'English' THEN 'en'
      WHEN 'Chinese' THEN 'zh'
      WHEN 'Japanese' THEN 'ja'
      WHEN 'Korean' THEN 'ko'
      ELSE 'unknown'
    END AS language,
    CASE
      WHEN p.status IS DISTINCT FROM 'active' THEN 'product_inactive'
      WHEN a.id IS NULL OR a.status IS DISTINCT FROM 'active' THEN 'author_inactive'
      WHEN COALESCE(BTRIM(a.page_username), '') = '' THEN 'missing_username'
      WHEN COALESCE(BTRIM(p.title), '') = '' OR COALESCE(BTRIM(p.cover_url), '') = '' THEN 'missing_cover_or_title'
      WHEN COALESCE(BTRIM(p.pdf_storage_key), '') = '' AND COALESCE(BTRIM(p.pdf_file_url), '') = '' THEN 'missing_pdf_file'
      WHEN p.novel_type NOT IN ('Khmer', 'English', 'Chinese', 'Japanese', 'Korean') OR p.novel_type IS NULL THEN 'unknown_language'
      WHEN p.original_price IS NULL OR p.original_price <= 0 THEN 'missing_original_price'
      WHEN COALESCE(NULLIF(p.sale_price, 0), p.original_price) <= 0
        OR COALESCE(NULLIF(p.sale_price, 0), p.original_price) > p.original_price THEN 'invalid_author_price'
      WHEN ROUND(COALESCE(NULLIF(p.sale_price, 0), p.original_price) * 100) >
        GREATEST(1, FLOOR(ROUND(p.original_price * 100) * 0.8)) THEN 'discount_below_20_percent'
      ELSE 'eligible_for_smart_pdf'
    END AS result
  FROM public.author_store_products p
  LEFT JOIN public.author_pages a ON a.id = p.author_page_id
  WHERE p.product_type = 'pdf'
)
SELECT language, result, COUNT(*) AS pdf_count
FROM candidates
GROUP BY language, result
ORDER BY language, result;
