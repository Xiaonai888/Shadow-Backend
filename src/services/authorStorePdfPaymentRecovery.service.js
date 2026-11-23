import { supabase } from '../config/supabase.js'
import { verifyAuthorStorePdfAbaPayment } from './authorStorePdfAbaVerify.service.js'
import { createAuthorStorePaidNotificationsSafely } from './authorStorePageNotifications.service.js'
import { sendAuthorStorePdfCompletedReports } from '../controllers/authorStore.controller.js'

const PAID_STATUSES = new Set(['confirmed', 'preparing', 'shipped', 'completed'])
const BLOCKED_RECOVERY_STATUSES = new Set([
  'refunded',
  'rejected',
  'cancelled',
  'canceled',
  'amount_mismatch',
  'failed',
])
const ORDER_ID = /^A[A-Z0-9]{8,19}$/
const RECHECK_CACHE_LIMIT = 256
const rechecksInFlight = new Map()
const recentPendingRechecks = new Map()
const ABA_VERIFY_CODES = new Set([
  'ABA_PDF_VERIFY_CONFIG',
  'ABA_PDF_VERIFY_URL',
  'ABA_PDF_VERIFY_MISMATCH',
  'ABA_PDF_VERIFY_HTTP',
])

function abaVerificationErrorCode(error) {
  const code = String(error?.code || '').toUpperCase()
  if (ABA_VERIFY_CODES.has(code)) return code
  const name = String(error?.name || '')
  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'ABA_PDF_VERIFY_TIMEOUT'
  }
  return 'ABA_PDF_VERIFY_NETWORK'
}

function abaRetrySeconds(code) {
  return code === 'ABA_PDF_VERIFY_CONFIG' || code === 'ABA_PDF_VERIFY_URL'
    || code === 'ABA_PDF_VERIFY_MISMATCH' ? 60 : 20
}

function pendingRecheckTtlMs(result) {
  if (result?.state === 'verification_unavailable') {
    return Math.min(60000, Math.max(5000, Number(result.retry_after_seconds || 20) * 1000))
  }
  if (result?.state === 'checking_payment') return 3000
  if (result?.state === 'payment_recheck_required') return 3000
  return 0
}

function pruneRecheckCache(now = Date.now()) {
  for (const [key, value] of recentPendingRechecks) {
    if (value.expires_at <= now) recentPendingRechecks.delete(key)
  }
  while (recentPendingRechecks.size > RECHECK_CACHE_LIMIT) {
    recentPendingRechecks.delete(recentPendingRechecks.keys().next().value)
  }
}

function isPaid(order) {
  return String(order?.payment_status || '').toLowerCase() === 'paid'
}

function isRecoveryBlocked(order) {
  return ['status', 'order_status', 'payment_status'].some((field) =>
    BLOCKED_RECOVERY_STATUSES.has(
      String(order?.[field] || '').toLowerCase()
    )
  )
}

function isUnlocked(order) {
  return isPaid(order)
    && PAID_STATUSES.has(String(order.status || '').toLowerCase())
    && String(order.pdf_unlock_status || '').toLowerCase() === 'unlocked'
}

function pdfProductIds(order) {
  const items = Array.isArray(order?.items) ? order.items : []
  if (!items.length || items.some((item) => String(item.product_type || '').toLowerCase() !== 'pdf'
      || Number(item.quantity) !== 1 || !item.product_id)) return []
  const ids = items.map((item) => String(item.product_id))
  return new Set(ids).size === ids.length ? ids : []
}

function publicResult(order, state, extra = {}) {
  return {
    ok: state !== 'verification_unavailable',
    state,
    order_id: order.order_id,
    product_ids: pdfProductIds(order),
    pdf_unlock_status: String(order.pdf_unlock_status || 'pending'),
    library_path: '/library',
    ...extra,
  }
}

async function readPdfOrder(buyerId, orderId) {
  const { data, error } = await supabase
    .from('author_store_orders')
    .select('*,items:author_store_order_items(*)')
    .eq('buyer_id', buyerId)
    .eq('order_id', orderId)
    .maybeSingle()
  if (error) throw error
  if (!data || !pdfProductIds(data).length) {
    const error = new Error('PDF order not found')
    error.statusCode = 404
    throw error
  }
  return data
}

async function grantsFor(order) {
  const ids = pdfProductIds(order)
  const { data, error } = await supabase
    .from('author_store_reader_downloads')
    .select('product_id,order_id')
    .eq('buyer_id', order.buyer_id)
    .in('product_id', ids)
  if (error) throw error
  return data || []
}

async function ensurePdfGrants(order) {
  const ids = pdfProductIds(order)
  const existing = await grantsFor(order)
  const owned = new Set(existing.map((row) => String(row.product_id)))
  const missing = ids.filter((id) => !owned.has(id))
  if (!missing.length) return true

  const { data: products, error: productsError } = await supabase
    .from('author_store_products')
    .select('id,author_page_id,title,cover_url,pdf_file_url,pdf_storage_key,pdf_file_name,access_rule,product_type')
    .in('id', missing)
  if (productsError) throw productsError

  const byId = new Map((products || []).map((product) => [String(product.id), product]))
  const payload = missing.map((id) => {
    const product = byId.get(id)
    if (!product || String(product.product_type || '').toLowerCase() !== 'pdf'
      || (!product.pdf_storage_key && !product.pdf_file_url)) return null
    return {
      buyer_id: order.buyer_id,
      author_page_id: product.author_page_id || order.author_page_id,
      product_id: id,
      order_id: order.id,
      order_number: order.order_id,
      title: product.title || '',
      cover_url: product.cover_url || '',
      pdf_file_url: product.pdf_file_url || '',
      pdf_file_name: product.pdf_file_name || `${product.title || 'download'}.pdf`,
      access_rule: product.access_rule || 'download',
    }
  })
  if (payload.some((row) => !row)) return false

  const { error } = await supabase
    .from('author_store_reader_downloads')
    .upsert(payload, { onConflict: 'buyer_id,product_id', ignoreDuplicates: true })
  if (error) throw error
  const finalGrants = await grantsFor(order)
  const finalIds = new Set(finalGrants.map((grant) => String(grant.product_id)))
  return ids.every((id) => finalIds.has(id))
}

async function finalizePaidPdfOrder(order) {
  if (!isPaid(order) || isRecoveryBlocked(order)) {
    return publicResult(order, 'payment_recheck_required', {
      code: 'PDF_RECOVERY_BLOCKED',
    })
  }

  const complete = await ensurePdfGrants(order)
  if (!complete) return publicResult(order, 'access_recovery')
  if (isUnlocked(order)) return publicResult(order, 'purchased')

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('author_store_orders')
    .update({
      status: 'confirmed',
      order_status: 'confirmed',
      payment_status: 'paid',
      pdf_unlock_status: 'unlocked',
      pdf_unlocked_at: now,
      pdf_unlock_count: pdfProductIds(order).length,
      confirmed_at: order.confirmed_at || now,
      updated_at: now,
    })
    .eq('id', order.id)
    .eq('payment_status', 'paid')
    .eq('status', String(order.status || 'under_review'))
    .eq('pdf_unlock_status', String(order.pdf_unlock_status || 'pending'))
    .select('*,items:author_store_order_items(*)')
    .maybeSingle()
  if (error) throw error
  if (!data) {
    const latest = await readPdfOrder(order.buyer_id, order.order_id)
    return isUnlocked(latest) ? publicResult(latest, 'purchased') : publicResult(latest, 'access_recovery')
  }

  await createAuthorStorePaidNotificationsSafely(data)
  try {
    await sendAuthorStorePdfCompletedReports(data)
  } catch (reportError) {
    console.error('AUTHOR PDF RECHECK REPORT FAILED:', String(reportError?.message || reportError).slice(0, 300))
  }
  return publicResult(data, 'purchased', { recovered: true })
}

async function checkBinance(order) {
  const purchaseId = String(order.request_payload?.binance_purchase_id || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(purchaseId)) return publicResult(order, 'access_recovery')

  const { data, error } = await supabase
    .from('shadow_binance_purchase_orders')
    .select('id,status,user_id,verified_transaction_id,fulfilled_at,expires_at,purchase_snapshot')
    .eq('id', purchaseId)
    .eq('user_id', order.buyer_id)
    .eq('purchase_kind', 'pdf')
    .maybeSingle()
  if (error) throw error
  if (!data || String(data.purchase_snapshot?.author_order_id) !== String(order.id)) {
    return publicResult(order, 'access_recovery')
  }

  if (data.status === 'fulfilled' && data.verified_transaction_id && data.fulfilled_at) {
    if (!isPaid(order)) return publicResult(order, 'access_recovery')
    return finalizePaidPdfOrder(order)
  }

  if (isPaid(order)) return publicResult(order, 'access_recovery')
  const expired = Date.parse(data.expires_at || '') <= Date.now()
  return publicResult(order, expired ? 'payment_recheck_required' : 'checking_payment', {
    verification_source: 'binance_worker',
  })
}

async function recheckAuthorStorePdfOrderUncached(buyerId, orderId) {
  const userId = String(buyerId || '').trim()
  const publicId = String(orderId || '').trim()
  if (!userId || !ORDER_ID.test(publicId)) {
    const error = new Error('Invalid PDF order')
    error.statusCode = 400
    throw error
  }
  let order = await readPdfOrder(userId, publicId)

  if (isRecoveryBlocked(order)) {
    return publicResult(order, 'payment_recheck_required', {
      code: 'PDF_RECOVERY_BLOCKED',
    })
  }

  const binance = String(order.request_payload?.payment_method || '').toLowerCase().includes('binance')
    || Boolean(order.request_payload?.binance_purchase_id)

  if (isUnlocked(order)) return finalizePaidPdfOrder(order)
  if (binance) return checkBinance(order)
  if (isPaid(order)) return finalizePaidPdfOrder(order)
  if (order.status !== 'waiting_payment' || String(order.payment_status || '').toLowerCase() !== 'pending') {
    return publicResult(order, 'payment_recheck_required')
  }

  let verified
  try {
    verified = await verifyAuthorStorePdfAbaPayment(order)
  } catch (error) {
    const code = abaVerificationErrorCode(error)
    console.error('AUTHOR PDF ABA RECHECK UNAVAILABLE:', code)
    return publicResult(order, 'verification_unavailable', {
      code,
      verification_source: 'aba_payway',
      diagnostic_stage: 'verify_transaction',
      retry_after_seconds: abaRetrySeconds(code),
    })
  }
  if (!verified.verified) {
    const expired = Date.parse(order.expires_at || '') <= Date.now()
    return publicResult(order, expired ? 'payment_recheck_required' : 'checking_payment')
  }

  const now = new Date().toISOString()
  const { data: claimed, error: claimError } = await supabase
    .from('author_store_orders')
    .update({
      status: 'under_review',
      order_status: 'under_review',
      payment_status: 'paid',
      paid_at: now,
      updated_at: now,
    })
    .eq('id', order.id)
    .eq('buyer_id', userId)
    .eq('status', 'waiting_payment')
    .eq('payment_status', 'pending')
    .select('*,items:author_store_order_items(*)')
    .maybeSingle()
  if (claimError) throw claimError
  order = claimed || await readPdfOrder(userId, publicId)
  if (!isPaid(order)) return publicResult(order, 'payment_recheck_required')
  return finalizePaidPdfOrder(order)
}


export async function recheckAuthorStorePdfOrder(buyerId, orderId) {
  const userId = String(buyerId || '').trim()
  const publicId = String(orderId || '').trim()
  if (!userId || !ORDER_ID.test(publicId)) {
    const error = new Error('Invalid PDF order')
    error.statusCode = 400
    throw error
  }

  const key = `${userId}:${publicId}`
  const now = Date.now()
  pruneRecheckCache(now)

  const pending = rechecksInFlight.get(key)
  if (pending) return pending

  const cached = recentPendingRechecks.get(key)
  if (cached && cached.expires_at > now) return { ...cached.result }
  if (cached) recentPendingRechecks.delete(key)

  const promise = recheckAuthorStorePdfOrderUncached(userId, publicId)
  rechecksInFlight.set(key, promise)
  try {
    const result = await promise
    const ttlMs = pendingRecheckTtlMs(result)
    if (ttlMs > 0) {
      recentPendingRechecks.delete(key)
      recentPendingRechecks.set(key, {
        result,
        expires_at: Date.now() + ttlMs,
      })
      pruneRecheckCache()
    }
    return result
  } finally {
    if (rechecksInFlight.get(key) === promise) rechecksInFlight.delete(key)
  }
}
