import { supabase } from '../config/supabase.js'
import { evaluateBinanceCheckoutEvidence } from './binanceCheckoutEvidence.service.js'

const PAGE_SIZE = 10
const MAX_PAGE = 1000
const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const CLAIM_FIELDS = 'order_id,user_id,transaction_id,review_status,submitted_at,reviewed_at'
const ORDER_FIELDS = 'id,user_id,package_usd,diamonds,amount_usdt,bonus_vouchers,receiver_uid,receiver_name,status,created_at,expires_at,verified_transaction_id,verified_at,credited_at'
const RECEIPT_FIELDS = 'transaction_id,transaction_time_ms,amount,currency,order_type,payer_name,created_at'
const CREDIT_FIELDS = 'id,transaction_id,user_id,amount_usdt,diamonds,created_at'
const USER_FIELDS = 'id,name,username'
const STATUS_SET = new Set(['submitted', 'approved', 'rejected', 'all'])

export class BinanceAdminReviewError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

function readPage(value) {
  const text = String(value ?? '1').trim()
  if (!/^\d{1,4}$/.test(text)) throw new BinanceAdminReviewError('INVALID_PAGE')
  const page = Number(text)
  if (page < 1 || page > MAX_PAGE) throw new BinanceAdminReviewError('INVALID_PAGE')
  return page
}

function readStatus(value) {
  const status = String(value || 'submitted').trim().toLowerCase()
  if (!STATUS_SET.has(status)) throw new BinanceAdminReviewError('INVALID_STATUS')
  return status
}

function unwrap(result) {
  if (result.error) throw result.error
  return result.data
}

async function getRelated(rows) {
  if (!rows.length) return { orders: new Map(), receipts: new Map(), users: new Map(), credits: new Map(), creditedOrders: new Map() }

  const orderIds = [...new Set(rows.map(item => item.order_id))]
  const receiptIds = [...new Set(rows.map(item => item.transaction_id))]
  const userIds = [...new Set(rows.map(item => item.user_id))]
  const results = await Promise.all([
    supabase.from('binance_checkout_orders').select(ORDER_FIELDS).in('id', orderIds).limit(PAGE_SIZE),
    supabase.from('binance_usdt_alert_transactions').select(RECEIPT_FIELDS).in('transaction_id', receiptIds).limit(PAGE_SIZE),
    supabase.from('users').select(USER_FIELDS).in('id', userIds).limit(PAGE_SIZE),
    supabase.from('admin_binance_usdt_credit_actions').select(CREDIT_FIELDS).in('transaction_id', receiptIds).limit(PAGE_SIZE),
    supabase.from('binance_checkout_orders').select('id,verified_transaction_id').in('verified_transaction_id', receiptIds).limit(PAGE_SIZE),
  ])

  const [orders, receipts, users, credits, creditedOrders] = results.map(unwrap)
  return {
    orders: new Map(orders.map(row => [row.id, row])),
    receipts: new Map(receipts.map(row => [row.transaction_id, row])),
    users: new Map(users.map(row => [row.id, row])),
    credits: new Map(credits.map(row => [row.transaction_id, row])),
    creditedOrders: new Map(creditedOrders.map(row => [row.verified_transaction_id, row])),
  }
}

function present(claim, related) {
  const order = related.orders.get(claim.order_id) || null
  const receipt = related.receipts.get(claim.transaction_id) || null
  const creditedAction = related.credits.get(claim.transaction_id) || null
  const creditedOrder = related.creditedOrders.get(claim.transaction_id) || null
  return {
    order_id: claim.order_id,
    transaction_id: claim.transaction_id,
    user: related.users.get(claim.user_id) || { id: claim.user_id },
    claim_status: claim.review_status,
    submitted_at: claim.submitted_at,
    reviewed_at: claim.reviewed_at,
    order: order ? {
      status: order.status,
      package_usd: order.package_usd,
      diamonds: order.diamonds,
      amount_usdt: String(order.amount_usdt),
      bonus_vouchers: order.bonus_vouchers,
      receiver_uid: order.receiver_uid,
      receiver_name: order.receiver_name,
      created_at: order.created_at,
      expires_at: order.expires_at,
      credited_at: order.credited_at,
    } : null,
    receipt: receipt ? {
      transaction_id: receipt.transaction_id,
      amount_usdt: String(receipt.amount),
      currency: receipt.currency,
      payer_name: receipt.payer_name,
      order_type: receipt.order_type,
      transaction_time_ms: receipt.transaction_time_ms,
    } : null,
    evidence: evaluateBinanceCheckoutEvidence({ claim, order, receipt, creditedAction, creditedOrder }),
    read_only: true,
  }
}

export async function listBinanceCheckoutReviews({ page: pageInput, status: statusInput } = {}) {
  const page = readPage(pageInput)
  const status = readStatus(statusInput)
  let query = supabase.from('binance_checkout_claims').select(CLAIM_FIELDS)
  if (status !== 'all') query = query.eq('review_status', status)
  const offset = (page - 1) * PAGE_SIZE
  const rows = unwrap(await query.order('submitted_at', { ascending: false }).order('order_id', { ascending: false }).range(offset, offset + PAGE_SIZE)) || []
  const current = rows.slice(0, PAGE_SIZE)
  const related = await getRelated(current)
  return {
    items: current.map(row => present(row, related)),
    page,
    limit: PAGE_SIZE,
    status,
    has_next: rows.length > PAGE_SIZE,
    has_prev: page > 1,
    read_only: true,
    automatic_credit_enabled: false,
  }
}

export async function getBinanceCheckoutReview(orderId) {
  const id = String(orderId || '').trim()
  if (!UUID_RE.test(id)) throw new BinanceAdminReviewError('INVALID_ORDER_ID')
  const claim = unwrap(await supabase.from('binance_checkout_claims').select(CLAIM_FIELDS).eq('order_id', id).maybeSingle())
  if (!claim) throw new BinanceAdminReviewError('CLAIM_NOT_FOUND', 404)
  const related = await getRelated([claim])
  return present(claim, related)
}
