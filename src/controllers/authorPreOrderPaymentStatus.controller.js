import { getAuthorPreOrderPaymentAvailability } from '../services/authorPreOrderPaymentAvailability.service.js'
import { getReaderPreOrderStatus, listReaderPreOrderStatuses } from '../services/authorPreOrderOrderStatus.service.js'

function privacy(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0')
  res.set('Pragma', 'no-cache')
  res.set('Vary', 'Authorization')
  res.set('X-Content-Type-Options', 'nosniff')
}

function failure(res, error, action) {
  const code = String(error?.code || '')
  const status = Number(error?.statusCode)
  const expected = /^PRE_ORDER_[A-Z0-9_]+$/.test(code) && Number.isInteger(status) && status >= 400 && status < 600
  if (!expected) console.error(`PRE_ORDER_PAYMENT_STATUS_${action}:`, String(error?.message || error))
  return res.status(expected ? status : 503).json({
    ok: false,
    code: expected ? code : 'PRE_ORDER_BUYER_STATUS_UNAVAILABLE',
    message: expected ? error.message : 'Pre-order status is temporarily unavailable',
  })
}

export function getReaderPreOrderPaymentCapabilities(req, res) {
  privacy(res)
  return res.status(200).json({ ok: true, capabilities: getAuthorPreOrderPaymentAvailability() })
}

export async function getReaderPreOrderOrderStatus(req, res) {
  privacy(res)
  try {
    const order = await getReaderPreOrderStatus(req.user?.user_id, req.params.orderId)
    return res.status(200).json({ ok: true, order })
  } catch (error) {
    return failure(res, error, 'DETAIL')
  }
}

export async function getReaderPreOrderMyOrders(req, res) {
  privacy(res)
  try {
    const result = await listReaderPreOrderStatuses(req.user?.user_id, req.query)
    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    return failure(res, error, 'LIST')
  }
}
