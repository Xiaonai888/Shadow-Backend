WITH target AS (
  SELECT
    '9f318d3a-364f-4c1c-a20e-4bf6d1e42b58'::uuid AS buyer_id,
    '163e76a0-5296-4db3-a1e5-a14036696849'::uuid AS product_id,
    'AMWQMAM75A7BD6EAC'::text AS first_public_id,
    'AMWQMWJJ4D729DE5E'::text AS second_public_id
), first_order AS (
  SELECT o.* FROM public.author_store_orders o CROSS JOIN target t
  WHERE o.buyer_id = t.buyer_id AND o.order_id = t.first_public_id
), second_order AS (
  SELECT o.* FROM public.author_store_orders o CROSS JOIN target t
  WHERE o.buyer_id = t.buyer_id AND o.order_id = t.second_public_id
), grants AS (
  SELECT d.* FROM public.author_store_reader_downloads d CROSS JOIN target t
  WHERE d.buyer_id = t.buyer_id AND d.product_id = t.product_id
), paid_orders AS (
  SELECT COUNT(DISTINCT o.id) AS count_paid
  FROM public.author_store_orders o
  JOIN public.author_store_order_items i ON i.order_id = o.id
  CROSS JOIN target t
  WHERE o.buyer_id = t.buyer_id AND i.product_id = t.product_id
    AND lower(coalesce(i.product_type, '')) = 'pdf'
    AND lower(coalesce(o.payment_status, '')) = 'paid'
), guard AS (
  SELECT COUNT(*) AS enabled_guard
  FROM pg_catalog.pg_trigger tr
  WHERE tr.tgrelid = 'public.author_store_reader_downloads'::regclass
    AND tr.tgname = 'author_store_pdf_preserve_first_paid_grant_v1'
    AND tr.tgenabled IN ('O', 'A') AND NOT tr.tgisinternal
)
SELECT
  CASE WHEN
    (SELECT count(*) FROM first_order) = 1
    AND (SELECT count(*) FROM second_order) = 1
    AND (SELECT count(*) FROM grants) = 1
    AND (SELECT count_paid FROM paid_orders) = 2
    AND (SELECT enabled_guard FROM guard) = 1
    AND EXISTS (
      SELECT 1 FROM first_order f JOIN second_order s ON TRUE
      JOIN grants g ON g.order_id = s.id
      WHERE f.id <> s.id
        AND f.payment_status = 'paid' AND s.payment_status = 'paid'
        AND f.pdf_unlock_status = 'unlocked' AND s.pdf_unlock_status = 'unlocked'
        AND f.status IN ('confirmed', 'preparing', 'shipped', 'completed')
        AND s.status IN ('confirmed', 'preparing', 'shipped', 'completed')
        AND f.paid_at IS NOT NULL AND s.paid_at IS NOT NULL
        AND f.paid_at < s.paid_at
        AND f.total_usd = 1.25 AND s.total_usd = 1.25
        AND f.aba_transaction_id::text = '179527823620533'
        AND s.aba_transaction_id::text = '179527924341403'
        AND (SELECT COUNT(*) FROM public.author_store_order_items i WHERE i.order_id = f.id) = 1
        AND (SELECT COUNT(*) FROM public.author_store_order_items i WHERE i.order_id = s.id) = 1
        AND EXISTS (SELECT 1 FROM public.author_store_order_items i WHERE i.order_id = f.id AND i.product_id = g.product_id AND lower(i.product_type) = 'pdf' AND i.quantity = 1)
        AND EXISTS (SELECT 1 FROM public.author_store_order_items i WHERE i.order_id = s.id AND i.product_id = g.product_id AND lower(i.product_type) = 'pdf' AND i.quantity = 1)
    )
  THEN 'PASS_READY_FOR_STEP13_RELINK'
  ELSE 'STOP_REVIEW_REQUIRED' END AS preflight_result,
  (SELECT count_paid FROM paid_orders) AS paid_orders_for_pdf,
  (SELECT count(*) FROM grants) AS existing_grants,
  (SELECT enabled_guard FROM guard) AS enabled_grant_guard,
  (SELECT jsonb_agg(jsonb_build_object('order_id',o.order_id,'paid_at',o.paid_at,'payment_status',o.payment_status,'pdf_unlock_status',o.pdf_unlock_status,'total_usd',o.total_usd,'aba_transaction_id',o.aba_transaction_id)) FROM (
    SELECT * FROM first_order UNION ALL SELECT * FROM second_order
  ) o) AS paid_order_evidence,
  (SELECT jsonb_agg(jsonb_build_object('linked_order_db_id',g.order_id,'order_number',g.order_number)) FROM grants g) AS existing_grant_evidence;
