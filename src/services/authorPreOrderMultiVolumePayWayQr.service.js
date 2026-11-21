import { createHmac } from 'node:crypto'
import { preOrderError } from './authorPreOrderValidation.service.js'
import {
  preOrderPaymentCents,
  preOrderPaymentCurrency,
  preOrderPaymentTransaction,
} from './authorPreOrderPaymentValidation.service.js'

const PAYWAY_FIELDS = [
  'req_time', 'merchant_id', 'tran_id', 'amount', 'items', 'first_name',
  'last_name', 'email', 'phone', 'purchase_type', 'payment_option',
  'callback_url', 'return_deeplink', 'currency', 'custom_fields',
  'return_params', 'payout', 'lifetime', 'qr_image_template',
]

function officialUrl(value, host, pathname, code) {
  let url
  try { url = new URL(value) } catch {
    throw preOrderError(code, 'Payment endpoint is not configured', 503)
  }
  if (url.protocol !== 'https:' || url.hostname !== host ||
      url.pathname !== pathname || url.port || url.username || url.password ||
      url.search || url.hash) {
    throw preOrderError(code, 'Payment endpoint is invalid', 503)
  }
  return url.href
}

function gatewayQrUrl() {
  const mode = String(process.env.ABA_PAYWAY_MODE || 'sandbox').trim().toLowerCase()
  if (!['sandbox', 'production', 'live'].includes(mode)) {
    throw preOrderError('PRE_ORDER_MULTI_QR_MODE_INVALID', 'Payment gateway mode is invalid', 503)
  }
  const host = mode === 'sandbox' ? 'checkout-sandbox.payway.com.kh' : 'checkout.payway.com.kh'
  const pathname = '/api/payment-gateway/v1/payments/generate-qr'
  return officialUrl(process.env.ABA_PAYWAY_QR_URL || `https://${host}${pathname}`, host, pathname, 'PRE_ORDER_MULTI_QR_ENDPOINT_INVALID')
}

function callbackUrl() {
  const origin = String(process.env.SHADOW_BACKEND_PUBLIC_ORIGIN || '').trim()
  let parsed
  try { parsed = new URL(origin) } catch {
    throw preOrderError('PRE_ORDER_MULTI_QR_ORIGIN_INVALID', 'Backend public origin is not configured', 503)
  }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.port || parsed.search || parsed.hash ||
      parsed.username || parsed.password || !parsed.hostname) {
    throw preOrderError('PRE_ORDER_MULTI_QR_ORIGIN_INVALID', 'Backend public origin is invalid', 503)
  }
  return officialUrl(
    process.env.ABA_PAYWAY_PREORDER_CALLBACK_URL || '',
    parsed.hostname,
    '/api/author-store/pre-orders/aba-callback',
    'PRE_ORDER_MULTI_QR_CALLBACK_INVALID'
  )
}

function requestTime() {
  const d = new Date()
  return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'), String(d.getUTCHours()).padStart(2, '0'),
    String(d.getUTCMinutes()).padStart(2, '0'), String(d.getUTCSeconds()).padStart(2, '0')].join('')
}

function buildPayWayItems(review) {
  if (!Array.isArray(review?.items) || review.items.length < 1 || review.items.length > 10) {
    throw preOrderError('PRE_ORDER_MULTI_QR_ITEMS_INVALID', 'Multi-volume checkout items are invalid', 503)
  }
  const seen = new Set()
  let subtotal = 0
  const items = review.items.map(item => {
    const bookId = String(item?.book_id || '').toLowerCase()
    const quantity = Number(item?.quantity)
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(bookId) || seen.has(bookId) ||
        !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99 ||
        !['standard', 'limited'].includes(item?.edition)) {
      throw preOrderError('PRE_ORDER_MULTI_QR_ITEMS_INVALID', 'Multi-volume checkout selection is invalid', 503)
    }
    seen.add(bookId)
    const cents = preOrderPaymentCents(item.unit_price_usd, 'book price')
    const lineTotal = cents * quantity
    if (cents < 1 || !Number.isSafeInteger(lineTotal) ||
        preOrderPaymentCents(item.line_total_usd, 'book total') !== lineTotal) {
      throw preOrderError('PRE_ORDER_MULTI_QR_AMOUNT_INVALID', 'Multi-volume line total is invalid', 503)
    }
    subtotal += lineTotal
    const title = String(item.book_title || 'Pre-order volume').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80)
    return { name: `${title} (${item.edition})`.slice(0, 100), quantity, price: cents / 100 }
  })
  if (!Number.isSafeInteger(subtotal) || subtotal !== preOrderPaymentCents(review.subtotal_usd, 'subtotal')) {
    throw preOrderError('PRE_ORDER_MULTI_QR_AMOUNT_INVALID', 'Multi-volume subtotal is invalid', 503)
  }
  const signatureFee = preOrderPaymentCents(review.signature_fee_usd, 'signature fee')
  const deliveryFee = preOrderPaymentCents(review.delivery_fee_usd, 'delivery fee')
  if (review.signature_requested !== true && signatureFee !== 0) {
    throw preOrderError('PRE_ORDER_MULTI_QR_AMOUNT_INVALID', 'Unexpected signature fee', 503)
  }
  if (signatureFee > 0) items.push({ name: 'Signed copy service', quantity: 1, price: signatureFee / 100 })
  if (deliveryFee > 0) items.push({ name: 'Delivery', quantity: 1, price: deliveryFee / 100 })
  const total = subtotal + signatureFee + deliveryFee
  if (!Number.isSafeInteger(total) || total !== preOrderPaymentCents(review.total_usd, 'checkout total')) {
    throw preOrderError('PRE_ORDER_MULTI_QR_AMOUNT_INVALID', 'Multi-volume checkout total is invalid', 503)
  }
  return { items, total }
}

export async function initializeAuthorPreOrderMultiVolumeQr(intent, review, { holdExpiresAt, signal } = {}) {
  const transaction = preOrderPaymentTransaction(intent?.merchant_transaction_id)
  const intentCents = preOrderPaymentCents(intent?.expected_amount_usd, 'payment intent')
  preOrderPaymentCurrency(intent?.currency)
  const intentExpiry = Date.parse(String(intent?.expires_at || ''))
  const holdExpiry = Date.parse(String(holdExpiresAt || ''))
  if (!Number.isFinite(intentExpiry) || !Number.isFinite(holdExpiry) ||
      intentExpiry > holdExpiry || intentExpiry <= Date.now() + 60_000 ||
      intent.finalized_at || review?.inventory_reserved !== true || review?.payment_created !== false ||
      review?.order_created !== true || !review?.order_id || intent?.order_id !== review.order_id) {
    throw preOrderError('PRE_ORDER_MULTI_QR_HOLD_INVALID', 'Payment cannot start without a valid stock hold', 409)
  }
  const { items, total } = buildPayWayItems(review)
  if (intentCents < 1 || intentCents !== total) {
    throw preOrderError('PRE_ORDER_MULTI_QR_AMOUNT_INVALID', 'Stock hold and payment amount disagree', 409)
  }
  const minutes = Math.floor((intentExpiry - Date.now()) / 60_000)
  if (minutes < 1 || minutes > 15) {
    throw preOrderError('PRE_ORDER_MULTI_QR_EXPIRY_INVALID', 'Invalid payment expiry', 409)
  }
  const merchant = String(process.env.ABA_PAYWAY_MERCHANT_ID || '').trim()
  const key = String(process.env.ABA_PAYWAY_API_KEY || '').trim()
  if (!merchant || !key || merchant.length > 80) {
    throw preOrderError('PRE_ORDER_MULTI_QR_UNCONFIGURED', 'PayWay is not configured', 503)
  }
  const url = gatewayQrUrl()
  const callback = callbackUrl()
  const reqTime = requestTime()
  const body = {
    req_time: reqTime,
    merchant_id: merchant,
    tran_id: transaction,
    amount: (intentCents / 100).toFixed(2),
    items: Buffer.from(JSON.stringify(items), 'utf8').toString('base64'),
    first_name: String(review.buyer_snapshot?.name || 'Shadow').slice(0, 50),
    last_name: 'Preorder',
    email: String(process.env.ABA_PAYWAY_DEFAULT_EMAIL || 'support@shadowerabook.site'),
    phone: String(review.buyer_snapshot?.phone_number || '').slice(0, 28),
    purchase_type: 'purchase',
    payment_option: String(process.env.ABA_PAYWAY_PAYMENT_OPTION || 'abapay_khqr'),
    callback_url: Buffer.from(callback, 'utf8').toString('base64'),
    currency: 'USD',
    return_params: JSON.stringify({ order_id: intent.order_id, type: 'author_pre_order' }),
    lifetime: minutes,
    qr_image_template: String(process.env.ABA_PAYWAY_QR_TEMPLATE || 'template3_color'),
  }
  const hash = createHmac('sha512', key)
    .update(PAYWAY_FIELDS.map(field => body[field] ?? '').join(''))
    .digest('base64')
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, hash }),
      signal: signal || AbortSignal.timeout(8000),
      cache: 'no-store',
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw preOrderError('PRE_ORDER_MULTI_QR_UNREACHABLE', 'PayWay QR could not be initialized', 503)
  }
  if (!response.ok) {
    throw preOrderError('PRE_ORDER_MULTI_QR_PROVIDER_FAILED', 'PayWay QR generation failed', 503)
  }
  let result
  try { result = await response.json() } catch {
    throw preOrderError('PRE_ORDER_MULTI_QR_RESPONSE_INVALID', 'Invalid PayWay response', 503)
  }
  const status = String(result?.status?.code ?? '')
  if (status && !['0', '00'].includes(status)) {
    throw preOrderError('PRE_ORDER_MULTI_QR_PROVIDER_FAILED', 'PayWay QR request was declined', 503)
  }
  const data = result?.data || result || {}
  const qrString = String(data.qrString || data.qr_string || data.khqr || data.qr || '')
  const qrImage = String(data.qrImage || data.qr_image || '')
  const deeplink = String(data.abapay_deeplink || data.deeplink || '')
  const checkoutUrl = String(data.checkout_url || data.payment_url || data.url || '')
  const providerId = String(data.transaction_id || data.tran_id || '').trim()
  if ((!qrString && !qrImage && !deeplink && !checkoutUrl) ||
      providerId && providerId !== transaction) {
    throw preOrderError('PRE_ORDER_MULTI_QR_RESPONSE_INVALID', 'PayWay QR response is incomplete', 503)
  }
  return {
    transaction_id: transaction,
    amount_usd: intentCents / 100,
    currency: 'USD',
    expires_at: intent.expires_at,
    qr_string: qrString.slice(0, 8192),
    qr_image: qrImage.slice(0, 250000),
    deeplink: deeplink.slice(0, 4000),
    checkout_url: checkoutUrl.slice(0, 4000),
  }
}
