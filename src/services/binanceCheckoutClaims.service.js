import { supabase } from '../config/supabase.js'

const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const TRANSACTION_RE = /^[A-Za-z0-9_-]{6,128}$/
const DECIMAL_RE = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/
const FIELDS = 'order_id,user_id,review_status,submitted_at,reviewed_at'

export class BinanceClaimError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.name = 'BinanceClaimError'
    this.code = code
    this.status = status
  }
}

function validateIdentity(userId, orderId) {
  const owner = String(userId || '').trim()
  const order = String(orderId || '').trim()
  if (!UUID_RE.test(owner)) throw new BinanceClaimError('UNAUTHORIZED', 401)
  if (!UUID_RE.test(order)) throw new BinanceClaimError('INVALID_ORDER_ID', 400)
  return { owner, order }
}

function present(row) {
  return {
    order_id: row.order_id,
    review_status: row.review_status,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at || null,
    payment_confirmed: false,
    automatic_credit_enabled: false,
  }
}

export async function submitBinanceCheckoutClaim({ userId, orderId, transactionId }) {
  const { owner, order } = validateIdentity(userId, orderId)
  const transaction = String(transactionId || '').trim()
  if (!TRANSACTION_RE.test(transaction)) {
    throw new BinanceClaimError('INVALID_TRANSACTION_ID', 400)
  }

  const { data, error } = await supabase.rpc('submit_binance_checkout_claim_v1', {
    p_user_id: owner,
    p_order_id: order,
    p_transaction_id: transaction,
  })

  if (error) {
    const reason = String(error.message || '')
    if (reason.includes('BINANCE_CHECKOUT_NOT_FOUND')) throw new BinanceClaimError('CHECKOUT_NOT_FOUND', 404)
    if (reason.includes('BINANCE_ORDER_ALREADY_CLAIMED')) throw new BinanceClaimError('ORDER_ALREADY_CLAIMED', 409)
    if (reason.includes('BINANCE_ORDER_NOT_CLAIMABLE')) throw new BinanceClaimError('ORDER_NOT_CLAIMABLE', 409)
    if (reason.includes('BINANCE_CLAIM_WINDOW_CLOSED')) throw new BinanceClaimError('CLAIM_WINDOW_CLOSED', 409)
    if (reason.includes('BINANCE_TRANSACTION_ALREADY_CLAIMED') || error.code === '23505') {
      throw new BinanceClaimError('TRANSACTION_ALREADY_CLAIMED', 409)
    }
    if (reason.includes('INVALID_BINANCE_CLAIM')) throw new BinanceClaimError('INVALID_TRANSACTION_ID', 400)
    throw error
  }

  if (data?.ok !== true || data?.order_id !== order || data?.review_status !== 'submitted' && data?.review_status !== 'approved' && data?.review_status !== 'rejected') {
    throw new Error('Unexpected Binance claim result')
  }

  return {
    order_id: data.order_id,
    review_status: data.review_status,
    submitted_at: data.submitted_at,
    payment_confirmed: false,
    automatic_credit_enabled: false,
  }
}

export async function getBinanceCheckoutClaim({ userId, orderId }) {
  const { owner, order } = validateIdentity(userId, orderId)
  const { data, error } = await supabase
    .from('binance_checkout_claims')
    .select(FIELDS)
    .eq('order_id', order)
    .eq('user_id', owner)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new BinanceClaimError('CLAIM_NOT_FOUND', 404)
  return present(data)
}

// ADMIN-ONLY SERVICE ENTRYPOINT. A future authenticated, passkey-verified Admin
// handler may call this after the Admin independently verifies the exact reader
// and official Binance receipt. Never call it from a reader-facing endpoint.
// It reuses the existing atomic claim RPC and DOES NOT award any wallet credit.
function usdtUnits(value) {
  const text = String(value ?? '').trim()
  if (!DECIMAL_RE.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'))
}

export async function linkBinanceReceiptToCheckoutForAdmin({ orderId, transactionId }) {
  const id = String(orderId || '').trim()
  const transaction = String(transactionId || '').trim()
  if (!UUID_RE.test(id)) throw new BinanceClaimError('INVALID_ORDER_ID', 400)
  if (!TRANSACTION_RE.test(transaction)) throw new BinanceClaimError('INVALID_TRANSACTION_ID', 400)

  const { data: order, error: orderError } = await supabase
    .from('binance_checkout_orders')
    .select('id,user_id,status,amount_usdt,created_at,expires_at,credited_at')
    .eq('id', id)
    .maybeSingle()
  if (orderError) throw orderError
  if (!order) throw new BinanceClaimError('CHECKOUT_NOT_FOUND', 404)
  if (!['waiting_payment', 'pending_review'].includes(order.status) || order.credited_at) {
    throw new BinanceClaimError('ORDER_NOT_CLAIMABLE', 409)
  }

  const [receiptResult, creditResult, linkedResult] = await Promise.all([
    supabase.from('binance_usdt_alert_transactions')
      .select('transaction_id,currency,amount,transaction_time_ms')
      .eq('transaction_id', transaction).maybeSingle(),
    supabase.from('admin_binance_usdt_credit_actions')
      .select('id').eq('transaction_id', transaction).limit(1).maybeSingle(),
    supabase.from('binance_checkout_orders')
      .select('id').eq('verified_transaction_id', transaction).limit(1).maybeSingle(),
  ])
  if (receiptResult.error) throw receiptResult.error
  if (creditResult.error) throw creditResult.error
  if (linkedResult.error) throw linkedResult.error
  if (!receiptResult.data) throw new BinanceClaimError('RECEIPT_NOT_FOUND', 404)
  if (creditResult.data || linkedResult.data) throw new BinanceClaimError('TRANSACTION_ALREADY_CREDITED', 409)

  const receipt = receiptResult.data
  const expected = usdtUnits(order.amount_usdt)
  const paid = usdtUnits(receipt.amount)
  if (receipt.currency !== 'USDT' || expected === null || paid === null || expected <= 0n || paid !== expected) {
    throw new BinanceClaimError('RECEIPT_AMOUNT_MISMATCH', 409)
  }
  const received = Number(receipt.transaction_time_ms)
  const created = Date.parse(order.created_at)
  const expires = Date.parse(order.expires_at)
  if (!Number.isSafeInteger(received) || !Number.isFinite(created) || !Number.isFinite(expires)
    || received < created - 60000 || received > expires + 600000) {
    throw new BinanceClaimError('RECEIPT_TIME_MISMATCH', 409)
  }

  // SQL serializes order changes and prevents one transaction from being
  // claimed against multiple orders. Admin approval and passkey are separate.
  const claim = await submitBinanceCheckoutClaim({
    userId: order.user_id,
    orderId: id,
    transactionId: transaction,
  })
  return {
    ...claim,
    receipt_linked: true,
    approval_required: true,
    automatic_credit_enabled: false,
  }
}
