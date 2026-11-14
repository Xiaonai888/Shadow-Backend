WITH languages(code, label) AS (
  VALUES
    ('km', 'khmer'),
    ('en', 'english'),
    ('zh', 'chinese'),
    ('ja', 'japanese'),
    ('ko', 'korean')
), ranked AS (
  SELECT
    s.id::text AS story_id,
    lower(btrim(coalesce(s.story_language, ''))) AS language,
    e.is_locked,
    e.is_free_published,
    row_number() OVER (
      PARTITION BY s.id
      ORDER BY coalesce(e.first_published_at, to_timestamp(0)),
               e.episode_number, e.created_at, e.id
    ) AS published_rank
  FROM public.stories s
  JOIN public.author_pages a ON a.id = s.author_id
  JOIN public.episodes e ON e.story_id = s.id
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
    AND e.status = 'published'
    AND e.deleted_at IS NULL
    AND (e.first_published_at IS NULL OR e.first_published_at <= now())
), eligible AS (
  SELECT story_id, language
  FROM ranked
  GROUP BY story_id, language
  HAVING count(*) FILTER (
    WHERE coalesce(is_locked, false)
      AND NOT coalesce(is_free_published, false)
      AND published_rank > 5
  ) >= 5
)
SELECT
  l.code AS story_language,
  count(DISTINCT e.story_id) AS eligible_special_promotion_stories
FROM languages l
LEFT JOIN eligible e ON e.language IN (l.code, l.label)
GROUP BY l.code
ORDER BY l.code;

WITH languages(code, label) AS (
  VALUES
    ('km', 'khmer'),
    ('en', 'english'),
    ('zh', 'chinese'),
    ('ja', 'japanese'),
    ('ko', 'korean')
), eligible_pdf AS (
  SELECT p.id, lower(btrim(coalesce(p.novel_type, ''))) AS language
  FROM public.author_store_products p
  JOIN public.author_pages a ON a.id = p.author_page_id
  WHERE p.product_type = 'pdf'
    AND p.status = 'active'
    AND a.status = 'active'
    AND (a.admin_status IS NULL OR a.admin_status = 'active')
    AND nullif(btrim(a.page_username), '') IS NOT NULL
    AND nullif(btrim(p.title), '') IS NOT NULL
    AND nullif(btrim(p.cover_url), '') IS NOT NULL
    AND (CASE WHEN coalesce(p.sale_price, 0) > 0
          THEN p.sale_price ELSE coalesce(p.original_price, 0) END) > 0
)
SELECT
  l.code AS story_language,
  count(p.id) AS eligible_pdf_products
FROM languages l
LEFT JOIN eligible_pdf p ON p.language IN (l.code, l.label)
GROUP BY l.code
ORDER BY l.code;
