import { createHash } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { BinanceReceiverUnavailableError, getVerifiedBinanceReceiver } from './binanceReceiverGuard.service.js'

const PRICES = new Map([[1, 100], [5, 500], [10, 1000], [20, 2000], [50, 5000], [100, 10000]])
const COLUMNS = 'id,user_id,package_usd,diamonds,amount_usdt,bonus_vouchers,receiver_uid,receiver_name,receiver_qr_sha256,status,created_at,expires_at,credited_at'
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const RECEIVER_QR_PATH = '/api/purchase/binance/receiver/qr'
const CHECKOUT_TTL_MS = 15 * 60 * 1000
const RECEIPT_RECONCILE_MS = 24 * 60 * 60 * 1000

export class BinanceCheckoutError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.name = 'BinanceCheckoutError'
    this.code = code
    this.status = status
  }
}

export function readBinancePackage(packageUsd) {
  const usd = Number(packageUsd)
  if (!Number.isSafeInteger(usd) || !PRICES.has(usd)) {
    throw new BinanceCheckoutError('INVALID_PACKAGE', 400)
  }
  return { packageUsd: usd, diamonds: PRICES.get(usd), amountUsdt: usd + 1, bonusVouchers: 100 }
}

function requireUserId(userId) {
  const value = String(userId || '').trim()
  if (!ID_PATTERN.test(value)) throw new BinanceCheckoutError('UNAUTHORIZED', 401)
  return value
}

function requireOrderId(orderId) {
  const value = String(orderId || '').trim()
  if (!ID_PATTERN.test(value)) throw new BinanceCheckoutError('INVALID_ORDER_ID', 400)
  return value
}

async function verifyReceiver() {
  const receiver = await getVerifiedBinanceReceiver()
  return {
    uid: receiver.uid,
    name: receiver.name,
    qrHash: createHash('sha256').update(receiver.qrBytes).digest('hex'),
  }
}

function matchesReceiver(row, receiver) {
  return row.receiver_uid === receiver.uid
    && row.receiver_name === receiver.name
    && row.receiver_qr_sha256 === receiver.qrHash
}

// Reconcile older 30-minute orders with the new 15-minute checkout lifetime.
// This does not terminate a payment already submitted for Admin review.
function checkoutDeadline(row) {
  const stored = Date.parse(String(row?.expires_at || ''))
  const created = Date.parse(String(row?.created_at || ''))
  const fifteenMinutes = Number.isFinite(created) ? created + CHECKOUT_TTL_MS : NaN
  if (!Number.isFinite(stored)) return fifteenMinutes
  if (!Number.isFinite(fifteenMinutes)) return stored
  return Math.min(stored, fifteenMinutes)
}

function isExpired(row) {
  const deadline = checkoutDeadline(row)
  return !Number.isFinite(deadline) || deadline <= Date.now()
}

function present(row, receiverVerified = false) {
  const status = row.status === 'waiting_payment' && isExpired(row) ? 'expired' : row.status
  const payable = status === 'waiting_payment' && receiverVerified
  const deadline = checkoutDeadline(row)
  return {
    id: row.id,
    package_usd: row.package_usd,
    diamonds: row.diamonds,
    amount_usdt: String(row.amount_usdt),
    bonus_vouchers: row.bonus_vouchers,
    receiver: payable ? { uid: row.receiver_uid, name: row.receiver_name } : null,
    qr_path: payable ? RECEIVER_QR_PATH : null,
    checkout_ready: payable,
    status,
    expires_at: Number.isFinite(deadline) ? new Date(deadline).toISOString() : row.expires_at,
    created_at: row.created_at,
    credited_at: row.credited_at || null,
    awaiting_verification: row.status === 'waiting_payment' && isExpired(row),
    automatic_credit_enabled: false,
  }
}

async function activeOrder(userId) {
  const { data, error } = await supabase
    .from('binance_checkout_orders')
    .select(COLUMNS)
    .eq('user_id', userId)
    .in('status', ['waiting_payment', 'pending_review'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

async function ensureNoReceiptForDiamond(row, userId) {
  // Unknown/changed payer identity is not proof of non-payment. Fail closed.
  const { data: profile, error: profileError } = await supabase
    .from('reader_binance_payment_profiles').select('binance_uid,updated_at')
    .eq('user_id', userId).maybeSingle()
  if (profileError) throw profileError
  if (!/^\d{5,20}$/.test(String(profile?.binance_uid || '')) ||
      Date.parse(profile.updated_at) > Date.parse(row.created_at)) {
    throw new BinanceCheckoutError('PAYMENT_REVIEW_REQUIRED', 409)
  }
  const start = Date.parse(row.created_at)
  const end = checkoutDeadline(row)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new BinanceCheckoutError('PAYMENT_REVIEW_REQUIRED', 409)
  }
  const { data: receipts, error: receiptError } = await supabase
    .from('binance_usdt_alert_transactions').select('transaction_id')
    .eq('payer_uid', profile.binance_uid).eq('receiver_uid', row.receiver_uid)
    .eq('amount', row.amount_usdt)
    .gte('transaction_time_ms', start - 60000).lte('transaction_time_ms', end + 60000)
    .limit(1)
  if (receiptError) throw receiptError
  if (receipts?.length) throw new BinanceCheckoutError('PAYMENT_REVIEW_REQUIRED', 409)
}

async function activeUniversalPurchase(userId) {
  const { data, error } = await supabase
    .from('shadow_binance_purchase_orders')
    .select('id,status,created_at')
    .eq('user_id', userId)
    .in('status', ['waiting_payment', 'pending_review'])
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  if (error) throw error
  if (!data) return false
  // Stay clear of active Premium/PDF receipts throughout the matching window.
  return data.status === 'pending_review' ||
    !Number.isFinite(Date.parse(data.created_at)) ||
    Date.now() < Date.parse(data.created_at) + RECEIPT_RECONCILE_MS
}

async function expireActiveOrder(row, userId) {
  if (row.status !== 'waiting_payment' || !isExpired(row)) return
  const created = Date.parse(row.created_at)
  if (!Number.isFinite(created) || Date.now() < created + RECEIPT_RECONCILE_MS) {
    throw new BinanceCheckoutError('PAYMENT_VERIFICATION_WINDOW', 409)
  }
  await ensureNoReceiptForDiamond(row, userId)
  const { data, error } = await supabase
    .from('binance_checkout_orders')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('user_id', userId).eq('status', 'waiting_payment')
    .eq('created_at', row.created_at).is('credited_at', null)
    .select('id').maybeSingle()
  if (error) throw error
  if (!data) throw new BinanceCheckoutError('ACTIVE_CHECKOUT_EXISTS', 409)
}

export async function createBinanceCheckoutOrder({ userId, packageUsd }) {
  const owner = requireUserId(userId)
  const selected = readBinancePackage(packageUsd)
  if (await activeUniversalPurchase(owner)) throw new BinanceCheckoutError('ACTIVE_CHECKOUT_EXISTS', 409)
  const receiver = await verifyReceiver()
  const previous = await activeOrder(owner)

  if (previous) {
    if (previous.status === 'waiting_payment' && isExpired(previous)) {
      await expireActiveOrder(previous, owner)
    } else if (previous.status === 'waiting_payment'
      && Number(previous.package_usd) === selected.packageUsd
      && matchesReceiver(previous, receiver)) {
      return present(previous, true)
    } else {
      throw new BinanceCheckoutError('ACTIVE_CHECKOUT_EXISTS', 409)
    }
  }

  const { data, error } = await supabase
    .from('binance_checkout_orders')
    .insert({
      user_id: owner,
      package_usd: selected.packageUsd,
      diamonds: selected.diamonds,
      amount_usdt: selected.amountUsdt,
      bonus_vouchers: selected.bonusVouchers,
      receiver_uid: receiver.uid,
      receiver_name: receiver.name,
      receiver_qr_sha256: receiver.qrHash,
      expires_at: new Date(Date.now() + CHECKOUT_TTL_MS).toISOString(),
    })
    .select(COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') throw new BinanceCheckoutError('ACTIVE_CHECKOUT_EXISTS', 409)
    throw error
  }
  return present(data, true)
}

export async function getBinanceCheckoutOrder({ userId, orderId }) {
  const owner = requireUserId(userId)
  const id = requireOrderId(orderId)
  const { data, error } = await supabase
    .from('binance_checkout_orders')
    .select(COLUMNS)
    .eq('id', id)
    .eq('user_id', owner)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new BinanceCheckoutError('CHECKOUT_NOT_FOUND', 404)
  if (data.status === 'waiting_payment' && !isExpired(data)) {
    try {
      const receiver = await verifyReceiver()
      if (matchesReceiver(data, receiver)) return present(data, true)
    } catch (receiverError) {
      if (!(receiverError instanceof BinanceReceiverUnavailableError)) throw receiverError
    }
  }
  return present(data, false)
}

export async function cancelBinanceCheckoutOrder({ userId, orderId }) {
  const owner = requireUserId(userId)
  const id = requireOrderId(orderId)
  const active = await activeOrder(owner)
  if (active && active.id === id && active.status === 'waiting_payment') {
    await ensureNoReceiptForDiamond(active, owner)
  }
  const { data, error } = await supabase
    .from('binance_checkout_orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', owner)
    .eq('status', 'waiting_payment')
    .is('credited_at', null)
    .select(COLUMNS)
    .maybeSingle()
  if (error) throw error
  if (data) return present(data)
  const { data: existing, error: readError } = await supabase
    .from('binance_checkout_orders')
    .select(COLUMNS)
    .eq('id', id)
    .eq('user_id', owner)
    .maybeSingle()
  if (readError) throw readError
  if (!existing) throw new BinanceCheckoutError('CHECKOUT_NOT_FOUND', 404)
  return present(existing)
}
