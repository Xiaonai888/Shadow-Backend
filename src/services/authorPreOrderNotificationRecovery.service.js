import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { queueVerifiedAuthorPreOrderPaidNotifications } from './authorPreOrderPaidNotification.service.js'

export async function recoverAuthorPreOrderPaidNotificationJobs({ limit = 10 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw preOrderError('PRE_ORDER_NOTIFY_RECOVERY_LIMIT_INVALID', 'Invalid notification recovery limit', 400)
  }
  const { data: orders, error } = await supabase
    .from('author_preorder_orders')
    .select('id')
    .eq('payment_status', 'paid')
    .order('paid_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('PRE_ORDER_NOTIFY_RECOVERY_LIST_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_NOTIFY_RECOVERY_UNAVAILABLE', 'Could not inspect paid orders', 503)
  }
  let alreadyQueued = 0
  let newJobs = 0
  const failures = []
  for (const order of orders || []) {
    try {
      const result = await queueVerifiedAuthorPreOrderPaidNotifications(order.id)
      newJobs += result.newly_queued
      if (result.newly_queued === 0) alreadyQueued += 1
    } catch (cause) {
      const code = String(cause?.code || '')
      failures.push({ order_id: order.id, code: /^PRE_ORDER_[A-Z0-9_]+$/.test(code) ? code : 'PRE_ORDER_NOTIFY_RECOVERY_ERROR' })
    }
  }
  return {
    checked: (orders || []).length,
    new_jobs: newJobs,
    orders_already_queued: alreadyQueued,
    failed_orders: failures,
    recent_orders_only: true,
  }
}
