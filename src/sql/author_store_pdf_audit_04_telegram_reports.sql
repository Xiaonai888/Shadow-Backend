WITH paid_pdf_orders AS (
  SELECT
    o.id,
    o.order_id,
    o.buyer_id,
    o.created_at,
    o.telegram_status,
    o.request_payload
  FROM public.author_store_orders o
  WHERE lower(coalesce(o.payment_status, '')) = 'paid'
    AND lower(coalesce(o.pdf_unlock_status, '')) = 'unlocked'
    AND o.created_at >= now() - interval '7 days'
    AND EXISTS (
      SELECT 1
      FROM public.author_store_order_items i
      WHERE i.order_id = o.id
        AND lower(coalesce(i.product_type, '')) = 'pdf'
    )
), per_recipient AS (
  SELECT
    o.order_id,
    o.buyer_id,
    o.created_at,
    r.recipient,
    o.request_payload -> 'pdf_telegram_reports' -> r.recipient ->> 'status' AS report_status,
    o.request_payload -> 'pdf_telegram_reports' -> r.recipient ->> 'error' AS report_error,
    o.request_payload -> 'pdf_telegram_reports' -> r.recipient ->> 'retry_attempts' AS retry_attempts,
    o.request_payload -> 'pdf_telegram_reports' -> r.recipient ->> 'retry_attempted_at' AS last_retry_at,
    o.telegram_status AS author_telegram_status
  FROM paid_pdf_orders o
  CROSS JOIN (VALUES ('admin'), ('author')) AS r(recipient)
)
SELECT
  CASE
    WHEN report_status IS NULL THEN 'NO_REPORT_RECORD'
    WHEN report_status = 'failed' THEN 'FAILED_PENDING_RETRY'
    WHEN report_status = 'review_required' THEN 'MANUAL_REVIEW_REQUIRED'
    WHEN report_status = 'sending' THEN 'SEND_RESULT_NOT_CONFIRMED'
    WHEN report_status = 'not_linked' THEN 'RECIPIENT_NOT_LINKED'
    ELSE 'OTHER_UNFINISHED_STATUS'
  END AS issue,
  order_id,
  buyer_id,
  recipient,
  report_status,
  author_telegram_status,
  coalesce(retry_attempts, '0') AS retry_attempts,
  last_retry_at,
  left(coalesce(report_error, ''), 180) AS report_error,
  created_at
FROM per_recipient
WHERE report_status IS DISTINCT FROM 'sent'
ORDER BY created_at DESC, order_id, recipient
LIMIT 250;
