import { supabase } from '../config/supabase.js'

const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const TRANSACTION_RE = /^[A-Za-z0-9_-]{6,128}$/
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
