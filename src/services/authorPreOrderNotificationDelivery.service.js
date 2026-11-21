import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'

function count(value, field) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw preOrderError('PRE_ORDER_NOTIFY_DELIVERY_RESPONSE_INVALID', `Invalid ${field}`, 503)
  }
  return number
}

export async function deliverAuthorPreOrderInAppNotifications({ limit = 10 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw preOrderError('PRE_ORDER_NOTIFY_DELIVERY_LIMIT_INVALID', 'Invalid notification batch size', 400)
  }
  const { data, error } = await supabase.rpc('author_preorder_deliver_inapp_notifications', {
    p_limit: limit,
  })
  if (error) {
    console.error('PRE_ORDER_NOTIFY_DELIVERY_RPC_FAILED:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_NOTIFY_DELIVERY_UNAVAILABLE', 'Could not deliver in-app notifications', 503)
  }
  const delivered = count(data?.delivered_jobs, 'delivered jobs')
  const created = count(data?.new_notifications, 'new notifications')
  const existed = count(data?.existing_notifications, 'existing notifications')
  const remaining = count(data?.remaining_ready, 'remaining jobs')
  if (delivered > limit || created + existed !== delivered) {
    throw preOrderError('PRE_ORDER_NOTIFY_DELIVERY_RESPONSE_INVALID', 'Delivery counts do not match', 503)
  }
  return {
    delivered_jobs: delivered,
    new_notifications: created,
    existing_notifications: existed,
    remaining_ready: remaining,
    delivery_channel: 'in_app',
  }
}
