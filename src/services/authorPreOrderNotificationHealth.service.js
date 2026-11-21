import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'

function nonnegative(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw preOrderError('PRE_ORDER_NOTIFY_HEALTH_INVALID', 'Invalid queue health data', 503)
  }
  return number
}

export async function getAuthorPreOrderNotificationHealth() {
  const { data, error } = await supabase.rpc('author_preorder_notification_health')
  if (error) {
    console.error('PRE_ORDER_NOTIFY_HEALTH_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_NOTIFY_HEALTH_UNAVAILABLE', 'Notification queue is unavailable', 503)
  }
  const queued = nonnegative(data?.queued)
  const failed = nonnegative(data?.failed)
  const processing = nonnegative(data?.processing)
  const sent = nonnegative(data?.sent)
  const ready = nonnegative(data?.ready)
  const oldest = data?.oldest_pending_at || null
  const parsed = oldest === null ? null : Date.parse(String(oldest))
  if (ready > queued + failed || (oldest !== null && !Number.isFinite(parsed))) {
    throw preOrderError('PRE_ORDER_NOTIFY_HEALTH_INVALID', 'Notification queue health is inconsistent', 503)
  }
  return {
    queued,
    failed,
    processing,
    sent,
    ready,
    oldest_pending_at: oldest,
    oldest_pending_minutes: parsed === null ? null : Math.max(0, Math.floor((Date.now() - parsed) / 60000)),
    needs_attention: failed > 0 || processing > 0 || (parsed !== null && Date.now() - parsed > 30 * 60000),
  }
}
