// NEW: Binance Premium checkout intent API.
// Uses the verified receiver and immutable universal purchase order schema.
// It NEVER marks an order paid, credits wallets, grants vouchers, or activates
// Premium. Only auto_fulfill_shadow_binance_premium_v1 may do so atomically.
import { randomUUID, createHash } from 'node:crypto'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { requirePaymentCountry } from '../middleware/paymentCountryGate.middleware.js'
import { getVerifiedBinanceReceiver } from '../services/binanceReceiverGuard.service.js'

const router = express.Router()
const ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const UID_RE = /^\d{5,20}$/
const TTL_MS = 15 * 60_000
const REVIEW_GRACE_MS = 24 * 60 * 60_000
const QR_PATH = '/api/purchase/binance/receiver/qr'
const COLUMNS = [
  'id', 'user_id', 'purchase_kind', 'fulfillment_key',
  'list_price_usd', 'promotion_discount_usd', 'payable_usd',
  'binance_fee_usdt', 'amount_usdt', 'bonus_vouchers',
  'purchase_snapshot', 'receiver_uid', 'receiver_name', 'receiver_qr_sha256',
  'status', 'verified_transaction_id', 'created_at', 'expires_at',
  'verified_at', 'fulfilled_at', 'updated_at',
].join(',')
const PLANS = new Map([
  [1, { months: 1, price: 5, base: 180, bonus: 90 }],
  [3, { months: 3, price: 18, base: 540, bonus: 270 }],
  [12, { months: 12, price: 70, base: 2200, bonus: 1080 }],
])

const readLimit = rateLimit({
  windowMs: 60_000, limit: 45, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.ip),
})
const writeLimit = rateLimit({
  windowMs: 60_000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.ip),
})

function noStore(res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('X-Content-Type-Options', 'nosniff')
}
function errorResponse(res, code, message, status = 400) {
  return res.status(status).json({ ok: false, code, message })
}
function accountId(req) {
  const id = String(req.user?.user_id || req.user?.id || '')
  return ID_RE.test(id) ? id : null
}
function planByMonths(value) {
  if (!(typeof value === 'number' || typeof value === 'string')) return null
  if (!/^(1|3|12)$/.test(String(value))) return null
  return PLANS.get(Number(value)) || null
}
function safeError(error) {
  return String(error?.code || error?.message || error || 'Unknown').slice(0, 160)
}
function previewPlan(plan) {
  return {
    plan_months: plan.months,
    price_usd: plan.price,
    fee_usdt: 1,
    amount_usdt: String(plan.price + 1),
    base_diamonds: plan.base,
    bonus_diamonds: plan.bonus,
    total_diamonds: plan.base + plan.bonus,
    bonus_vouchers: 100,
  }
}
function formatOrder(row, canPay = false) {
  const plan = PLANS.get(Number(row?.purchase_snapshot?.plan_months)) || null
  const ended = new Date(row.expires_at).getTime() <= Date.now()
  const ready = row.status === 'waiting_payment' && !ended && canPay
  return {
    id: row.id,
    order_id: row.id,
    purchase_kind: row.purchase_kind,
    plan_months: plan?.months || null,
    base_diamonds: plan?.base || null,
    bonus_diamonds: plan?.bonus || null,
    total_diamonds: plan ? plan.base + plan.bonus : null,
    price_usd: String(row.payable_usd),
    binance_fee_usdt: String(row.binance_fee_usdt),
    amount_usdt: String(row.amount_usdt),
    bonus_vouchers: Number(row.bonus_vouchers),
    status: row.status,
    checkout_ready: ready,
    checkout_expired: ended && row.status === 'waiting_payment',
    // A transfer sent during the checkout window may reach the official
    // receipt feed later. Never expire it merely because the QR timed out.
    awaiting_verification: ended && row.status === 'waiting_payment',
    receiver: ready ? { uid: row.receiver_uid, name: row.receiver_name } : null,
    qr_path: ready ? QR_PATH : null,
    expires_at: row.expires_at,
    created_at: row.created_at,
    fulfilled_at: row.fulfilled_at || null,
  }
}
async function readerProfile(userId) {
  const { data, error } = await supabase
    .from('reader_binance_payment_profiles')
    .select('binance_uid,updated_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  const uid = String(data?.binance_uid || '')
  if (!UID_RE.test(uid)) return null
  return { uid, updatedAt: data.updated_at }
}
async function profileAvailableForOrder(userId, row) {
  const profile = await readerProfile(userId)
  return Boolean(profile && Date.parse(profile.updatedAt) <= Date.parse(row.created_at))
}
async function existingUniversalOrder(userId) {
  const { data, error } = await supabase
    .from('shadow_binance_purchase_orders')
    .select(COLUMNS)
    .eq('user_id', userId)
    .in('status', ['waiting_payment', 'pending_review'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data || null
}
async function expireUnpaidAfterGrace(row, userId) {
  // Step 9 only auto-matches for 24 hours after checkout creation. A 15-minute
  // QR timeout alone does NOT prove that a payment was not sent.
  if (row.status !== 'waiting_payment' || Date.now() - Date.parse(row.created_at) < REVIEW_GRACE_MS) {
    return false
  }
  const { data, error } = await supabase
    .from('shadow_binance_purchase_orders')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('user_id', userId)
    .eq('status', 'waiting_payment')
    .is('verified_transaction_id', null)
    .is('fulfilled_at', null)
    .select('id')
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}
async function activeDiamondCheckout(userId) {
  const { data, error } = await supabase
    .from('binance_checkout_orders')
    .select('id,status,created_at,expires_at')
    .eq('user_id', userId)
    .in('status', ['waiting_payment', 'pending_review'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) return false
  // Pending review must be settled first. Old expired checkout records do
  // not prevent starting Premium after their payment window is long over.
  return data.status === 'pending_review'
    || (Date.now() - Date.parse(data.created_at) < REVIEW_GRACE_MS)
}

router.get('/plans', (_req, res) => {
  noStore(res)
  return res.status(200).json({
    ok: true, payment_method: 'binance_personal_pay',
    plans: [...PLANS.values()].map(previewPlan),
  })
})

router.post('/checkout', requireUser, writeLimit, requirePaymentCountry('binancePay'), async (req, res) => {
  noStore(res)
  const userId = accountId(req)
  const plan = planByMonths(req.body?.plan_months)
  if (!userId) return errorResponse(res, 'LOGIN_REQUIRED', 'Please sign in.', 401)
  if (!plan) return errorResponse(res, 'INVALID_PREMIUM_PLAN', 'Choose 1, 3 or 12 months.')

  try {
    const profile = await readerProfile(userId)
    if (!profile) {
      return errorResponse(res, 'BINANCE_PROFILE_REQUIRED', 'Save your Binance name and UID before starting checkout.', 409)
    }
    const { data: matchingProfiles, error: profileError } = await supabase
      .from('reader_binance_payment_profiles')
      .select('user_id')
      .eq('binance_uid', profile.uid)
      .limit(2)
    if (profileError) throw profileError
    if (!Array.isArray(matchingProfiles) || matchingProfiles.length !== 1 || matchingProfiles[0].user_id !== userId) {
      return errorResponse(res, 'BINANCE_UID_NOT_UNIQUE', 'This Binance UID is linked to another account. Contact Admin.', 409)
    }
    if (await activeDiamondCheckout(userId)) {
      return errorResponse(res, 'OTHER_BINANCE_CHECKOUT_ACTIVE', 'Finish your existing Diamond checkout first.', 409)
    }

    let old = await existingUniversalOrder(userId)
    if (old && await expireUnpaidAfterGrace(old, userId)) old = null
    if (old) {
      const samePlan = old.purchase_kind === 'premium'
        && Number(old.purchase_snapshot?.plan_months) === plan.months
      if (samePlan && old.status === 'waiting_payment') {
        const profileValid = await profileAvailableForOrder(userId, old)
        const receiver = await getVerifiedBinanceReceiver()
        const hash = createHash('sha256').update(receiver.qrBytes).digest('hex')
        if (profileValid && old.receiver_uid === receiver.uid && old.receiver_name === receiver.name && old.receiver_qr_sha256 === hash) {
          return res.status(200).json({ ok: true, reused: true, order: formatOrder(old, true) })
        }
        return errorResponse(res, 'ACTIVE_PREMIUM_CHECKOUT_STALE', 'Existing checkout cannot be reused. Verify its status or cancel if unpaid.', 409)
      }
      return errorResponse(res, 'OTHER_BINANCE_CHECKOUT_ACTIVE', 'Finish the existing Binance checkout before creating another.', 409)
    }

    const receiver = await getVerifiedBinanceReceiver()
    const qrHash = createHash('sha256').update(receiver.qrBytes).digest('hex')
    const id = randomUUID()
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString()
    const payload = {
      id,
      user_id: userId,
      purchase_kind: 'premium',
      fulfillment_key: `binance:premium:${id}`,
      list_price_usd: plan.price,
      promotion_discount_usd: 0,
      binance_fee_usdt: 1,
      bonus_vouchers: 100,
      author_income_usd: null,
      purchase_snapshot: {
        plan_months: plan.months,
        base_diamonds: plan.base,
        bonus_diamonds: plan.bonus,
        total_diamonds: plan.base + plan.bonus,
      },
      receiver_uid: receiver.uid,
      receiver_name: receiver.name,
      receiver_qr_sha256: qrHash,
      expires_at: expiresAt,
      status: 'waiting_payment',
    }
    const { data, error } = await supabase
      .from('shadow_binance_purchase_orders')
      .insert(payload)
      .select(COLUMNS)
      .single()
    if (error) {
      if (error.code === '23505') {
        // A concurrent create may have inserted the same order. Reuse the
        // winner rather than suggesting a second Binance transfer.
        const current = await existingUniversalOrder(userId)
        if (current?.purchase_kind === 'premium' && Number(current.purchase_snapshot?.plan_months) === plan.months) {
          const canPay = await profileAvailableForOrder(userId, current)
          return res.status(200).json({ ok: true, reused: true, order: formatOrder(current, canPay) })
        }
        return errorResponse(res, 'ACTIVE_CHECKOUT_EXISTS', 'An active checkout already exists.', 409)
      }
      throw error
    }
    return res.status(201).json({ ok: true, reused: false, order: formatOrder(data, true) })
  } catch (error) {
    console.error('BINANCE PREMIUM CREATE ERROR:', safeError(error))
    return errorResponse(res, 'BINANCE_PREMIUM_UNAVAILABLE', 'Unable to create a verified Binance checkout.', 503)
  }
})

router.get('/checkout/:orderId', requireUser, readLimit, async (req, res) => {
  noStore(res)
  const userId = accountId(req)
  if (!userId) return errorResponse(res, 'LOGIN_REQUIRED', 'Please sign in.', 401)
  if (!ID_RE.test(String(req.params.orderId || ''))) {
    return errorResponse(res, 'INVALID_ORDER_ID', 'Invalid Premium order.')
  }
  try {
    const { data, error } = await supabase
      .from('shadow_binance_purchase_orders')
      .select(COLUMNS)
      .eq('id', req.params.orderId)
      .eq('user_id', userId)
      .eq('purchase_kind', 'premium')
      .maybeSingle()
    if (error) throw error
    if (!data) return errorResponse(res, 'ORDER_NOT_FOUND', 'Premium order not found.', 404)
    let verifiedReceiver = false
    if (data.status === 'waiting_payment' && Date.parse(data.expires_at) > Date.now()) {
      const profileValid = await profileAvailableForOrder(userId, data)
      if (profileValid) {
        try {
          const receiver = await getVerifiedBinanceReceiver()
          const hash = createHash('sha256').update(receiver.qrBytes).digest('hex')
          verifiedReceiver = data.receiver_uid === receiver.uid && data.receiver_name === receiver.name && data.receiver_qr_sha256 === hash
        } catch {
          // A receiver QR outage must not hide an existing order's status.
          verifiedReceiver = false
        }
      }
    }
    return res.status(200).json({ ok: true, order: formatOrder(data, verifiedReceiver) })
  } catch (error) {
    console.error('BINANCE PREMIUM STATUS ERROR:', safeError(error))
    return errorResponse(res, 'BINANCE_PREMIUM_STATUS_UNAVAILABLE', 'Unable to read Binance Premium status.', 503)
  }
})

router.post('/checkout/:orderId/cancel', requireUser, writeLimit, async (req, res) => {
  noStore(res)
  const userId = accountId(req)
  if (!userId) return errorResponse(res, 'LOGIN_REQUIRED', 'Please sign in.', 401)
  if (!ID_RE.test(String(req.params.orderId || ''))) {
    return errorResponse(res, 'INVALID_ORDER_ID', 'Invalid Premium order.')
  }
  if (req.body?.confirm_not_paid !== true) {
    return errorResponse(res, 'PAYMENT_CONFIRMATION_REQUIRED', 'Confirm you have not sent USDT. Paid transfers must be reviewed, not cancelled.', 409)
  }
  try {
    const { data: row, error } = await supabase
      .from('shadow_binance_purchase_orders')
      .select(COLUMNS)
      .eq('id', req.params.orderId)
      .eq('user_id', userId)
      .eq('purchase_kind', 'premium')
      .maybeSingle()
    if (error) throw error
    if (!row) return errorResponse(res, 'ORDER_NOT_FOUND', 'Premium order not found.', 404)
    if (row.status === 'cancelled') return res.status(200).json({ ok: true, already_cancelled: true, order: formatOrder(row) })
    if (row.status !== 'waiting_payment') {
      return errorResponse(res, 'ORDER_NOT_CANCELLABLE', 'Paid or reviewed checkout cannot be cancelled.', 409)
    }

    const profile = await readerProfile(userId)
    // Fail closed when account binding is no longer known: never cancel
    // a possibly paid transaction on the basis of changed identity alone.
    if (!profile || Date.parse(profile.updatedAt) > Date.parse(row.created_at)) {
      return errorResponse(res, 'PAYMENT_REVIEW_REQUIRED', 'Binance profile changed; Admin must review this checkout.', 409)
    }
    const startMs = Date.parse(row.created_at) - 60_000
    const endMs = Date.parse(row.expires_at) + 600_000
    const { data: receipts, error: receiptError } = await supabase
      .from('binance_usdt_alert_transactions')
      .select('transaction_id')
      .eq('payer_uid', profile.uid)
      .eq('receiver_uid', row.receiver_uid)
      .eq('amount', row.amount_usdt)
      .gte('transaction_time_ms', startMs)
      .lte('transaction_time_ms', endMs)
      .limit(1)
    if (receiptError) throw receiptError
    if (receipts?.length) {
      return errorResponse(res, 'PAYMENT_RECEIVED_REVIEW_REQUIRED', 'A matching Binance transfer was recorded. Do not cancel; contact Admin.', 409)
    }
    const { data: cancelled, error: updateError } = await supabase
      .from('shadow_binance_purchase_orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('user_id', userId)
      .eq('status', 'waiting_payment')
      .is('verified_transaction_id', null)
      .is('fulfilled_at', null)
      .select(COLUMNS)
      .maybeSingle()
    if (updateError) throw updateError
    if (!cancelled) return errorResponse(res, 'ORDER_STATE_CHANGED', 'Refresh the order. Payment status changed.', 409)
    return res.status(200).json({ ok: true, order: formatOrder(cancelled) })
  } catch (error) {
    console.error('BINANCE PREMIUM CANCEL ERROR:', safeError(error))
    return errorResponse(res, 'BINANCE_PREMIUM_CANCEL_UNAVAILABLE', 'Unable to cancel checkout safely.', 503)
  }
})

export default router
