import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { assessAuthorPreOrderNotificationWorkerHealth } from './authorPreOrderNotificationWorkerPolicy.service.js'
import { getAuthorPreOrderNotificationWorkerState } from './authorPreOrderNotificationWorker.service.js'

export async function inspectAuthorPreOrderNotificationWorker() {
  const worker = getAuthorPreOrderNotificationWorkerState()
  const { data, error } = await supabase.rpc('author_preorder_notification_worker_health')
  if (error) {
    console.error('PRE_ORDER_NOTIFY_WORKER_HEALTH_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_NOTIFY_WORKER_HEALTH_UNAVAILABLE', 'Notification worker health is unavailable', 503)
  }
  const queue = assessAuthorPreOrderNotificationWorkerHealth(data)
  return {
    worker,
    queue,
    action_required: queue.needs_attention || (queue.ready > 0 && !worker.started),
    safe_to_enable: !queue.needs_attention && !worker.last_error_code,
    current_channel: 'in_app',
    telegram_enabled: false,
    manual_status_only: true,
  }
}
