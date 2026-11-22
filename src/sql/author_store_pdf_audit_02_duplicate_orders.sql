WITH pdf_orders AS (
  SELECT
    o.id AS order_db_id,
    o.order_id AS public_order_id,
    o.buyer_id,
    i.product_id,
    o.payment_status,
    o.status AS order_status,
    o.paid_at,
    o.created_at,
    o.total_usd,
    o.aba_transaction_id,
    o.request_payload ->> 'payment_method' AS payment_method
  FROM public.author_store_orders o
  JOIN public.author_store_order_items i ON i.order_id = o.id
  WHERE lower(coalesce(i.product_type, '')) = 'pdf'
), grouped AS (
  SELECT
    buyer_id,
    product_id,
    count(DISTINCT order_db_id) AS total_orders,
    count(DISTINCT order_db_id) FILTER (
      WHERE lower(coalesce(payment_status, '')) = 'paid'
    ) AS paid_orders,
    count(DISTINCT order_db_id) FILTER (
      WHERE lower(coalesce(payment_status, '')) <> 'paid'
        AND lower(coalesce(order_status, '')) IN ('waiting_payment', 'under_review')
    ) AS active_unpaid_orders,
    jsonb_agg(
      jsonb_build_object(
        'order_id', public_order_id,
        'payment_status', payment_status,
        'order_status', order_status,
        'payment_method', payment_method,
        'amount_usd', total_usd,
        'created_at', created_at,
        'paid_at', paid_at,
        'aba_transaction_id', aba_transaction_id
      ) ORDER BY created_at, order_db_id
    ) AS orders_to_review
  FROM pdf_orders
  GROUP BY buyer_id, product_id
), earliest_paid AS (
  SELECT DISTINCT ON (buyer_id, product_id)
    buyer_id,
    product_id,
    public_order_id AS first_paid_order_id
  FROM pdf_orders
  WHERE lower(coalesce(payment_status, '')) = 'paid'
  ORDER BY buyer_id, product_id, coalesce(paid_at, created_at), created_at, order_db_id
)
SELECT
  CASE
    WHEN g.paid_orders > 1 THEN 'CRITICAL_MULTIPLE_PAID_ORDERS'
    WHEN g.paid_orders > 0 AND g.active_unpaid_orders > 0 THEN 'PAID_WITH_ANOTHER_ACTIVE_ORDER'
    ELSE 'MULTIPLE_ACTIVE_UNPAID_ORDERS'
  END AS issue,
  g.buyer_id,
  g.product_id,
  g.total_orders,
  g.paid_orders,
  g.active_unpaid_orders,
  p.first_paid_order_id,
  g.orders_to_review
FROM grouped g
LEFT JOIN earliest_paid p
  ON p.buyer_id = g.buyer_id AND p.product_id = g.product_id
WHERE g.paid_orders > 1
  OR (g.paid_orders > 0 AND g.active_unpaid_orders > 0)
  OR g.active_unpaid_orders > 1
ORDER BY g.paid_orders DESC, g.active_unpaid_orders DESC, g.total_orders DESC
LIMIT 250;
