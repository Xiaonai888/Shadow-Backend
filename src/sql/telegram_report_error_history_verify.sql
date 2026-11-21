SELECT
  t.trx_id,
  t.match_status,
  t.report_status,
  t.report_attempts,
  t.report_sent_at,
  h.attempt_no,
  h.stage,
  h.error_code,
  h.error_message,
  h.created_at AS error_at,
  h.resolved_at,
  h.resolution,
  h.report_message_id,
  h.created_at + interval '7 days' AS error_history_expires_at
FROM public.telegram_payments AS t
LEFT JOIN public.telegram_report_error_history AS h
  ON h.telegram_payment_id = t.id
WHERE t.trx_id = '179527271896161'
ORDER BY h.created_at DESC NULLS LAST;
