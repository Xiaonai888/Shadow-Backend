import { preOrderError } from './authorPreOrderValidation.service.js'
import { getAuthorPreOrderPaymentAvailability } from './authorPreOrderPaymentAvailability.service.js'
import { createAuthorPreOrderPendingOrder } from './authorPreOrderPendingOrder.service.js'
import { ensureAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { initializeAuthorPreOrderPayWayQr } from './authorPreOrderPayWayQr.service.js'

export async function startReaderAuthorPreOrderCheckout(campaignId, buyerUserId, input, { signal } = {}) {
  const capabilities = getAuthorPreOrderPaymentAvailability()
  if (capabilities.payment_enabled !== true || capabilities.can_create_order !== true ||
      capabilities.can_start_payment !== true || capabilities.inventory_reservation_enabled !== true) {
    throw preOrderError('PRE_ORDER_PAYMENT_NOT_READY', 'Pre-order payment is not available yet', 503)
  }
  const pending = await createAuthorPreOrderPendingOrder(
    campaignId,
    buyerUserId,
    input?.request_key,
    input
  )
  const intent = await ensureAuthorPreOrderPaymentIntent(
    pending.order_id,
    buyerUserId,
    { expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
  )
  const qr = await initializeAuthorPreOrderPayWayQr(intent, pending.review, { signal })
  return {
    order_id: pending.order_id,
    payment_status: 'pending',
    order_created: true,
    reused: pending.reused,
    total_usd: pending.total_usd,
    qr,
  }
}
