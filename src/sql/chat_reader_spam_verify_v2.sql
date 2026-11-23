SELECT
  t.tgname AS trigger_name,
  CASE WHEN t.tgenabled <> 'D' THEN 'ENABLED' ELSE 'DISABLED' END AS trigger_status
FROM pg_trigger t
WHERE t.tgrelid IN (
  'public.chat_messages'::regclass,
  'public.chat_participants'::regclass
)
  AND t.tgname IN (
    'shadow_chat_enforce_reader_send_trigger_v1',
    'shadow_chat_on_delete_new_session_trigger_v1',
    'enforce_pending_reader_request_limit_trigger'
  )
ORDER BY t.tgname;

SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'shadow_chat_ensure_sender_state_v1',
    'shadow_chat_sender_quota_v1',
    'shadow_chat_enforce_reader_send_v1',
    'shadow_chat_mark_new_session_v1',
    'shadow_chat_on_delete_new_session_v1'
  )
ORDER BY p.proname;

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'chat_messages'
  AND indexdef ILIKE '%is_request_message%';

SELECT
  first_reply_pending,
  count(*) AS tracked_directions,
  max(pending_sent_count) AS max_first_reply_count,
  max(daily_unanswered_count) AS max_daily_unanswered_count
FROM public.chat_reader_send_limits
GROUP BY first_reply_pending
ORDER BY first_reply_pending;
