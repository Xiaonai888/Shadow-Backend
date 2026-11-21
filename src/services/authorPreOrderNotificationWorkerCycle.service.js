import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { validateAuthorPreOrderNotificationBatchLimit } from './authorPreOrderNotificationWorkerPolicy.service.js'

let pendingCycle = null

function count(value, field) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw preOrderError('PRE_ORDER_NOTIFY_WORKER_RESPONSE_INVALID', `Invalid ${field}`, 503)
  }
  return number
}

async function executeCycle(limit) {
  const { data, error } = await supabase.rpc('author_preorder_deliver_inapp_notifications_safe', {
    p_limit: limit,
  })
  if (error) {
    console.error('PRE_ORDER_NOTIFY_WORKER_RPC_ERROR:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_NOTIFY_WORKER_UNAVAILABLE', 'Notification worker could not process queued jobs', 503)
  }
  const delivered = count(data?.delivered_jobs, 'delivered jobs')
  const created = count(data?.new_notifications, 'new notifications')
  const existing = count(data?.existing_notifications, 'existing notifications')
  const failed = count(data?.failed_jobs, 'failed jobs')
  const remaining = count(data?.remaining_ready, 'remaining jobs')
  if (delivered + failed > limit || created + existing !== delivered) {
    throw preOrderError('PRE_ORDER_NOTIFY_WORKER_RESPONSE_INVALID', 'Notification worker counts are inconsistent', 503)
  }
  return {
    delivered_jobs: delivered,
    new_notifications: created,
    existing_notifications: existing,
    failed_jobs: failed,
    remaining_ready: remaining,
    processed_jobs: delivered + failed,
  }
}

export function runAuthorPreOrderNotificationWorkerCycle({ limit = 5 } = {}) {
  const safeLimit = validateAuthorPreOrderNotificationBatchLimit(limit)
  if (pendingCycle) return pendingCycle
  pendingCycle = executeCycle(safeLimit)
    .finally(() => { pendingCycle = null })
  return pendingCycle
}
