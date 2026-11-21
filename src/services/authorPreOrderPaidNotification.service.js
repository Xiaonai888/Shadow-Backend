import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

export async function queueVerifiedAuthorPreOrderPaidNotifications(orderId) {
  const id = preOrderUuid(orderId, 'order ID')
  const { data, error } = await supabase.rpc('author_preorder_queue_verified_paid_notifications', {
    p_order_id: id,
  })
  if (error) {
    const code = String(error.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
    if (code) {
      throw preOrderError(code, 'Paid order notification could not be queued', 409)
    }
    console.error('PRE_ORDER_PAID_NOTIFICATION_OUTBOX_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_PAID_NOTIFICATION_UNAVAILABLE', 'Notification queue is temporarily unavailable', 503)
  }
  if (!data || data.order_id !== id || data.recipient_jobs !== 2 ||
      !Number.isInteger(data.new_jobs) || data.new_jobs < 0 || data.new_jobs > 2 ||
      data.already_queued !== (data.new_jobs === 0)) {
    throw preOrderError('PRE_ORDER_PAID_NOTIFICATION_INVALID', 'Paid notification queue was not confirmed', 503)
  }
  return {
    order_id: id,
    queued: true,
    recipient_jobs: 2,
    newly_queued: data.new_jobs,
    delivery_completed: false,
  }
}
