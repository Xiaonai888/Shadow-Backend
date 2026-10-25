import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'
import {
  BinanceAdminDecisionError,
  approveBinanceCheckoutReview,
  rejectBinanceCheckoutReview,
} from '../services/binanceCheckoutAdminDecision.service.js'

const MESSAGES = {
  INVALID_ORDER_ID: 'Invalid Binance order ID.',
  INVALID_REASON: 'Give a review reason between 12 and 500 characters.',
  INVALID_DECISION: 'Invalid Binance review decision.',
  ORDER_NOT_FOUND: 'Binance payment order was not found.',
  CLAIM_NOT_FOUND: 'Binance payment report was not found.',
  NOT_PENDING_REVIEW: 'Payment order is not pending review.',
  ALREADY_DECIDED: 'This payment order has already been decided.',
  ALREADY_CREDITED: 'This payment order has already been credited.',
  CREDIT_AUDIT_MISSING: 'The payment credit audit record requires investigation.',
  RECEIPT_NOT_FOUND: 'Official Binance receipt was not found.',
  AMOUNT_MISMATCH: 'USDT amount does not match this order.',
  TIME_MISMATCH: 'Receipt time does not match the order window.',
  CREDIT_MISMATCH: 'Wallet credit verification failed.',
  CONFIRMATION_REQUIRED: 'Confirm the official receipt, Shadow recipient, and Binance receiver.',
  TRANSACTION_ALREADY_USED: 'This Binance transaction was already credited.',
  RECEIVER_CHANGED: 'Binance receiver information has changed. Do not approve.',
  DATABASE_NOT_READY: 'Install the required Binance checkout SQL first.',
}

function privateHeaders(res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('X-Content-Type-Options', 'nosniff')
}

function adminIdentity(req, res) {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  const id = String(req.admin?.admin_id || req.admin?.id || '').trim()
  const email = String(req.admin?.email || '').trim().toLowerCase()
  if (!['owner', 'admin'].includes(role) || id.length < 2 || email.length < 5) {
    res.status(403).json({ ok: false, message: 'Owner/Admin identity required.' })
    return null
  }
  return { id, email }
}

function failure(res, error) {
  if (error instanceof BinanceAdminDecisionError) {
    return res.status(error.status).json({ ok: false, code: error.code, message: MESSAGES[error.code] || 'Unable to review payment.' })
  }
  console.error('BINANCE CHECKOUT ADMIN DECISION ERROR:', String(error?.code || error?.name || 'UnknownError').slice(0, 80))
  return res.status(503).json({ ok: false, code: 'BINANCE_REVIEW_UNAVAILABLE', message: 'Binance payment review is temporarily unavailable.' })
}

async function handleDecision(req, res, type) {
  privateHeaders(res)
  const admin = adminIdentity(req, res)
  if (!admin) return
  if (type === 'approve' && (
    req.body?.official_receipt_verified !== true ||
    req.body?.recipient_verified !== true ||
    req.body?.receiver_verified !== true
  )) {
    return res.status(400).json({ ok: false, code: 'CONFIRMATION_REQUIRED', message: MESSAGES.CONFIRMATION_REQUIRED })
  }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  if (reason.length < 12 || reason.length > 500) {
    return res.status(400).json({ ok: false, code: 'INVALID_REASON', message: MESSAGES.INVALID_REASON })
  }
  const pin = typeof req.body?.passkey === 'string' ? req.body.passkey.trim() : ''
  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({ ok: false, code: 'PASSKEY_REQUIRED', message: 'Enter the six-digit Admin Passkey.' })
  }
  try {
    const purpose = `binance_checkout_${type}:${String(req.params.orderId || '').trim()}`
    const verified = await verifyAdminPasskeyPin({ admin: req.admin, req, pin, purpose })
    if (!verified.ok) return res.status(verified.status || 403).json({ ok: false, code: verified.code || 'PASSKEY_FAILED', message: verified.message || 'Passkey verification failed.' })
    const payload = { orderId: req.params.orderId, adminId: admin.id, adminEmail: admin.email, reason }
    const result = type === 'approve'
      ? await approveBinanceCheckoutReview(payload)
      : await rejectBinanceCheckoutReview(payload)
    return res.status(200).json({ ok: true, result })
  } catch (error) {
    return failure(res, error)
  }
}

export async function approveAdminBinanceCheckout(req, res) {
  return handleDecision(req, res, 'approve')
}

export async function rejectAdminBinanceCheckout(req, res) {
  return handleDecision(req, res, 'reject')
}
