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
    .select('id,user_id,status,amount_usdt,receiver_uid,created_at,expires_at,credited_at')
    .eq('id', id)
    .maybeSingle()
  if (orderError) throw orderError
  if (!order) throw new BinanceClaimError('CHECKOUT_NOT_FOUND', 404)
  if (!['waiting_payment', 'pending_review'].includes(order.status) || order.credited_at) {
    throw new BinanceClaimError('ORDER_NOT_CLAIMABLE', 409)
  }

  // A manually linked receipt must satisfy the SAME identity and global
  // consumption checks as the automatic Diamond/Premium/PDF workers.
  // A checked Admin confirmation box is not a substitute for actual evidence.
  const [receiptResult, creditResult, linkedResult, globalResult, profileResult] = await Promise.all([
    supabase.from('binance_usdt_alert_transactions')
      .select('transaction_id,currency,amount,transaction_time_ms,payer_uid,receiver_uid')
      .eq('transaction_id', transaction).maybeSingle(),
    supabase.from('admin_binance_usdt_credit_actions')
      .select('id').eq('transaction_id', transaction).limit(1).maybeSingle(),
    supabase.from('binance_checkout_orders')
      .select('id').eq('verified_transaction_id', transaction).limit(1).maybeSingle(),
    supabase.from('shadow_binance_payment_claims')
      .select('transaction_id').eq('provider', 'binance').eq('transaction_id', transaction).limit(1).maybeSingle(),
    supabase.from('reader_binance_payment_profiles')
      .select('binance_uid,updated_at').eq('user_id', order.user_id).maybeSingle(),
  ])
  for (const result of [receiptResult, creditResult, linkedResult, globalResult, profileResult]) {
    if (result.error) throw result.error
  }
  if (!receiptResult.data) throw new BinanceClaimError('RECEIPT_NOT_FOUND', 404)
  if (creditResult.data || linkedResult.data || globalResult.data) {
    throw new BinanceClaimError('TRANSACTION_ALREADY_CREDITED', 409)
  }

  const receipt = receiptResult.data
  if (!/^\d{5,20}$/.test(String(receipt.payer_uid || '')) ||
      String(receipt.receiver_uid || '') !== String(order.receiver_uid || '')) {
    throw new BinanceClaimError('RECEIVER_OR_PAYER_MISMATCH', 409)
  }
  if (String(profileResult.data?.binance_uid || '') !== String(receipt.payer_uid)) {
    throw new BinanceClaimError('PAYER_UID_MISMATCH', 409)
  }
  const profileUpdated = Date.parse(profileResult.data?.updated_at || '')
  const orderCreated = Date.parse(order.created_at || '')
  if (!Number.isFinite(profileUpdated) || !Number.isFinite(orderCreated) || profileUpdated > orderCreated) {
    throw new BinanceClaimError('PAYER_PROFILE_CHANGED', 409)
  }
  const { data: uidOwners, error: uidOwnersError } = await supabase
    .from('reader_binance_payment_profiles')
    .select('user_id').eq('binance_uid', String(receipt.payer_uid)).limit(2)
  if (uidOwnersError) throw uidOwnersError
  if (!Array.isArray(uidOwners) || uidOwners.length !== 1 || uidOwners[0].user_id !== order.user_id) {
    throw new BinanceClaimError('PAYER_UID_NOT_UNIQUE', 409)
  }

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

  // The claim RPC is idempotent per Diamond order, while the global receipt
  // ledger and its credit-action trigger enforce cross-type uniqueness at
  // fulfillment time. Prechecks above are defense-in-depth, not the SQL lock.
  // Admin approval and a fresh Admin Passkey are still required.
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
