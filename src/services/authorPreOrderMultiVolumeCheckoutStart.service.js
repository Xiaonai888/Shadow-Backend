import { preOrderError } from './authorPreOrderValidation.service.js'
import { getAuthorPreOrderPaymentAvailability } from './authorPreOrderPaymentAvailability.service.js'
import { createHeldAuthorPreOrderVolumes } from './authorPreOrderMultiVolumeHold.service.js'
import { ensureAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { initializeAuthorPreOrderMultiVolumeQr } from './authorPreOrderMultiVolumePayWayQr.service.js'

export async function startReaderMultiVolumePreOrderCheckout(campaignId, buyerUserId, input, { signal } = {}) {
  const capabilities = getAuthorPreOrderPaymentAvailability()
  if (capabilities.payment_enabled !== true || capabilities.can_create_order !== true ||
      capabilities.can_start_payment !== true || capabilities.inventory_reservation_enabled !== true) {
    throw preOrderError('PRE_ORDER_PAYMENT_NOT_READY', 'Pre-order checkout is not enabled', 503)
  }
  const held = await createHeldAuthorPreOrderVolumes(campaignId, buyerUserId, input?.request_key, input)
  const holdEnd = Date.parse(String(held.hold_expires_at || ''))
  const expiry = Math.min(holdEnd - 2000, Date.now() + 15 * 60_000)
  if (!Number.isFinite(holdEnd) || expiry < Date.now() + 90_000) {
    throw preOrderError('PRE_ORDER_MULTI_CHECKOUT_HOLD_TOO_OLD', 'The stock hold is too close to expiry', 409)
  }
  const intent = await ensureAuthorPreOrderPaymentIntent(held.order_id, buyerUserId, {
    expiresAt: new Date(expiry).toISOString(),
  })
  const qr = await initializeAuthorPreOrderMultiVolumeQr(intent, {
    ...held.review,
    order_id: held.order_id,
  }, { holdExpiresAt: held.hold_expires_at, signal })
  return {
    order_id: held.order_id,
    payment_status: 'pending',
    item_count: held.item_count,
    order_created: true,
    inventory_held: true,
    reused: held.reused,
    total_usd: held.total_usd,
    qr,
  }
}
