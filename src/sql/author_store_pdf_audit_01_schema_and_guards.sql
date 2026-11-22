WITH required_columns(table_name, column_name) AS (
  VALUES
    ('author_store_orders', 'id'),
    ('author_store_orders', 'buyer_id'),
    ('author_store_orders', 'order_id'),
    ('author_store_orders', 'payment_status'),
    ('author_store_orders', 'status'),
    ('author_store_orders', 'pdf_unlock_status'),
    ('author_store_orders', 'paid_at'),
    ('author_store_orders', 'request_payload'),
    ('author_store_order_items', 'order_id'),
    ('author_store_order_items', 'product_id'),
    ('author_store_order_items', 'product_type'),
    ('author_store_order_items', 'quantity'),
    ('author_store_reader_downloads', 'buyer_id'),
    ('author_store_reader_downloads', 'product_id'),
    ('author_store_reader_downloads', 'order_id'),
    ('author_store_reader_downloads', 'order_number')
), checks AS (
  SELECT
    'COLUMN'::text AS check_type,
    c.table_name || '.' || c.column_name AS check_name,
    EXISTS (
      SELECT 1
      FROM information_schema.columns col
      WHERE col.table_schema = 'public'
        AND col.table_name = c.table_name
        AND col.column_name = c.column_name
    ) AS installed
  FROM required_columns c
  UNION ALL
  SELECT
    'TRIGGER',
    'author_store_order_items.author_store_pdf_one_time_item_guard_v1',
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.author_store_order_items')
        AND t.tgname = 'author_store_pdf_one_time_item_guard_v1'
        AND t.tgenabled IN ('O', 'A')
        AND NOT t.tgisinternal
    )
  UNION ALL
  SELECT
    'TRIGGER',
    'author_store_reader_downloads.author_store_pdf_preserve_first_paid_grant_v1',
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.author_store_reader_downloads')
        AND t.tgname = 'author_store_pdf_preserve_first_paid_grant_v1'
        AND t.tgenabled IN ('O', 'A')
        AND NOT t.tgisinternal
    )
  UNION ALL
  SELECT
    'FUNCTION',
    'author_store_pdf_one_time_item_guard_v1()',
    pg_catalog.to_regprocedure('public.author_store_pdf_one_time_item_guard_v1()') IS NOT NULL
  UNION ALL
  SELECT
    'FUNCTION',
    'author_store_pdf_preserve_first_paid_grant_v1()',
    pg_catalog.to_regprocedure('public.author_store_pdf_preserve_first_paid_grant_v1()') IS NOT NULL
)
SELECT
  check_type,
  check_name,
  CASE WHEN installed THEN 'PASS' ELSE 'MISSING_OR_DISABLED' END AS result
FROM checks
ORDER BY CASE WHEN installed THEN 1 ELSE 0 END, check_type, check_name;
