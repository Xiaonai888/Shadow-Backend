import { preOrderError } from './authorPreOrderValidation.service.js'
import { deliverAuthorPreOrderInAppNotifications } from './authorPreOrderNotificationDelivery.service.js'
import { getAuthorPreOrderNotificationHealth } from './authorPreOrderNotificationHealth.service.js'
import { recoverAuthorPreOrderPaidNotificationJobs } from './authorPreOrderNotificationRecovery.service.js'

export async function dispatchAuthorPreOrderNotificationsOnce({ limit = 10, recoveryLimit = 0 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
      !Number.isSafeInteger(recoveryLimit) || recoveryLimit < 0 || recoveryLimit > 20) {
    throw preOrderError('PRE_ORDER_NOTIFY_DISPATCH_LIMIT_INVALID', 'Invalid notification dispatch limits', 400)
  }
  const recovered = recoveryLimit > 0
    ? await recoverAuthorPreOrderPaidNotificationJobs({ limit: recoveryLimit })
    : null
  const delivery = await deliverAuthorPreOrderInAppNotifications({ limit })
  const health = await getAuthorPreOrderNotificationHealth()
  return {
    delivery,
    recovery: recovered,
    health,
    executed_once: true,
    recurring_worker_started: false,
    telegram_sent: false,
  }
}
