WITH paid_pdf_orders AS (
  SELECT
    o.id AS paid_order_db_id,
    o.order_id AS paid_public_order_id,
    o.buyer_id,
    i.product_id,
    o.payment_status,
    o.pdf_unlock_status,
    o.paid_at,
    o.created_at,
    row_number() OVER (
      PARTITION BY o.buyer_id, i.product_id
      ORDER BY coalesce(o.paid_at, o.created_at), o.created_at, o.id
    ) AS sequence_number
  FROM public.author_store_orders o
  JOIN public.author_store_order_items i ON i.order_id = o.id
  WHERE lower(coalesce(i.product_type, '')) = 'pdf'
    AND lower(coalesce(o.payment_status, '')) = 'paid'
), first_paid AS (
  SELECT * FROM paid_pdf_orders WHERE sequence_number = 1
), grants AS (
  SELECT
    buyer_id,
    product_id,
    count(*) AS grant_count,
    min(order_id::text) AS linked_order_db_id
  FROM public.author_store_reader_downloads
  GROUP BY buyer_id, product_id
), paid_problems AS (
  SELECT
    CASE
      WHEN g.grant_count IS NULL THEN 'PAID_PDF_WITHOUT_GRANT'
      WHEN g.grant_count > 1 THEN 'DUPLICATE_GRANTS'
      WHEN g.linked_order_db_id IS DISTINCT FROM p.paid_order_db_id::text
        THEN 'GRANT_NOT_LINKED_TO_FIRST_PAID_ORDER'
      ELSE 'PAID_ORDER_NOT_MARKED_UNLOCKED'
    END AS issue,
    p.buyer_id,
    p.product_id,
    p.paid_public_order_id::text AS first_paid_order_id,
    g.linked_order_db_id,
    coalesce(g.grant_count, 0) AS grant_count,
    p.pdf_unlock_status::text AS recorded_unlock_status
  FROM first_paid p
  LEFT JOIN grants g
    ON g.buyer_id = p.buyer_id AND g.product_id = p.product_id
  WHERE g.grant_count IS NULL
    OR g.grant_count > 1
    OR g.linked_order_db_id IS DISTINCT FROM p.paid_order_db_id::text
    OR lower(coalesce(p.pdf_unlock_status, '')) <> 'unlocked'
), invalid_grants AS (
  SELECT
    CASE
      WHEN o.id IS NULL THEN 'GRANT_ORDER_NOT_FOUND'
      WHEN o.buyer_id IS DISTINCT FROM d.buyer_id THEN 'GRANT_BELONGS_TO_DIFFERENT_BUYER'
      ELSE 'GRANT_WITHOUT_PAID_SOURCE'
    END AS issue,
    d.buyer_id,
    d.product_id,
    NULL::text AS first_paid_order_id,
    d.order_id::text AS linked_order_db_id,
    1::bigint AS grant_count,
    coalesce(o.pdf_unlock_status, 'missing')::text AS recorded_unlock_status
  FROM public.author_store_reader_downloads d
  LEFT JOIN public.author_store_orders o ON o.id = d.order_id
  WHERE o.id IS NULL
    OR o.buyer_id IS DISTINCT FROM d.buyer_id
    OR lower(coalesce(o.payment_status, '')) <> 'paid'
)
SELECT * FROM paid_problems
UNION ALL
SELECT * FROM invalid_grants
ORDER BY issue, buyer_id, product_id
LIMIT 300;
