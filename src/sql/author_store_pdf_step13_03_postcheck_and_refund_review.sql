WITH target AS (
  SELECT '9f318d3a-364f-4c1c-a20e-4bf6d1e42b58'::uuid AS buyer_id,
         '163e76a0-5296-4db3-a1e5-a14036696849'::uuid AS product_id
), orders AS (
  SELECT o.id, o.order_id, o.paid_at, o.payment_status, o.pdf_unlock_status,
         o.total_usd, o.aba_transaction_id, o.request_payload
  FROM public.author_store_orders o
  JOIN public.author_store_order_items i ON i.order_id = o.id
  CROSS JOIN target t
  WHERE o.buyer_id = t.buyer_id AND i.product_id = t.product_id
    AND lower(coalesce(i.product_type, '')) = 'pdf'
    AND lower(coalesce(o.payment_status, '')) = 'paid'
), pdf_grants AS (
  SELECT d.order_id, d.order_number
  FROM public.author_store_reader_downloads d CROSS JOIN target t
  WHERE d.buyer_id = t.buyer_id AND d.product_id = t.product_id
), ranked AS (
  SELECT o.*, row_number() OVER (ORDER BY o.paid_at, o.order_id) AS payment_number
  FROM orders o
), summary AS (
  SELECT
    (SELECT count(*) FROM ranked) AS paid_order_count,
    (SELECT count(*) FROM pdf_grants) AS grant_count,
    (SELECT r.order_id FROM ranked r WHERE r.payment_number = 1) AS first_order_public_id,
    (SELECT r.id FROM ranked r WHERE r.payment_number = 1) AS first_order_db_id,
    (SELECT r.order_id FROM ranked r WHERE r.payment_number = 2) AS second_order_public_id,
    (SELECT r.aba_transaction_id FROM ranked r WHERE r.payment_number = 2) AS second_aba_transaction_id,
    (SELECT r.total_usd FROM ranked r WHERE r.payment_number = 2) AS second_charge_usd,
    (SELECT g.order_id FROM pdf_grants g LIMIT 1) AS linked_grant_order_db_id,
    (SELECT g.order_number FROM pdf_grants g LIMIT 1) AS linked_grant_public_id
)
SELECT
  CASE WHEN s.paid_order_count = 2 AND s.grant_count = 1
    AND s.linked_grant_order_db_id = s.first_order_db_id
    AND s.linked_grant_public_id = s.first_order_public_id
    THEN 'PASS_FIRST_PAID_ORDER_OWNS_PDF_GRANT'
    ELSE 'STOP_GRANT_STILL_REQUIRES_REVIEW' END AS grant_result,
  s.paid_order_count,
  s.grant_count,
  s.first_order_public_id,
  s.linked_grant_public_id,
  s.second_order_public_id AS extra_charge_to_review,
  s.second_aba_transaction_id AS extra_aba_transaction_to_review,
  s.second_charge_usd AS potential_manual_refund_usd,
  'REFUND_NOT_EXECUTED_VERIFY_ABA_SETTLEMENT_AND_REFUND_STATUS'::text AS refund_action,
  (SELECT jsonb_agg(jsonb_build_object(
    'order_id', r.order_id,
    'payment_number', r.payment_number,
    'telegram_admin_status', r.request_payload->'pdf_telegram_reports'->'admin'->>'status',
    'telegram_author_status', r.request_payload->'pdf_telegram_reports'->'author'->>'status'
  ) ORDER BY r.payment_number) FROM ranked r) AS telegram_report_snapshot
FROM summary s;
