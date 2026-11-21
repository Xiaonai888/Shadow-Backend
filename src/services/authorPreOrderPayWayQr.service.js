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
const HOSTS = new Set(['checkout.payway.com.kh', 'checkout-sandbox.payway.com.kh'])

function utcTime() {
  const d = new Date()
  return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'), String(d.getUTCHours()).padStart(2, '0'),
    String(d.getUTCMinutes()).padStart(2, '0'), String(d.getUTCSeconds()).padStart(2, '0')].join('')
}

function qrEndpoint() {
  const mode = String(process.env.ABA_PAYWAY_MODE || 'sandbox').toLowerCase()
  if (!['sandbox', 'production', 'live'].includes(mode)) {
    throw preOrderError('PRE_ORDER_QR_CONFIG_INVALID', 'Unknown PayWay mode', 503)
  }
  const host = mode === 'sandbox' ? 'checkout-sandbox.payway.com.kh' : 'checkout.payway.com.kh'
  const address = String(process.env.ABA_PAYWAY_QR_URL || `https://${host}/api/payment-gateway/v1/payments/generate-qr`)
  let url
  try { url = new URL(address) } catch {
    throw preOrderError('PRE_ORDER_QR_CONFIG_INVALID', 'PayWay QR URL is invalid', 503)
  }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.hostname !== host ||
      url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== '/api/payment-gateway/v1/payments/generate-qr') {
    throw preOrderError('PRE_ORDER_QR_CONFIG_INVALID', 'PayWay QR endpoint is not allowed', 503)
  }
  return url.href
}

function callbackEndpoint() {
  const address = String(process.env.ABA_PAYWAY_PREORDER_CALLBACK_URL || '').trim()
  const publicOrigin = String(process.env.SHADOW_BACKEND_PUBLIC_ORIGIN || 'https://shadow-backend-kucw.onrender.com').trim()
  let callback
  let origin
  try {
    callback = new URL(address)
    origin = new URL(publicOrigin)
  } catch {
    throw preOrderError('PRE_ORDER_CALLBACK_NOT_CONFIGURED', 'Pre-order callback URL is required', 503)
  }
  if (callback.protocol !== 'https:' || origin.protocol !== 'https:' ||
      callback.origin !== origin.origin || origin.pathname !== '/' || origin.search || origin.hash ||
      callback.pathname !== '/api/author-store/pre-orders/aba-callback' ||
      callback.username || callback.password || callback.search || callback.hash) {
    throw preOrderError('PRE_ORDER_CALLBACK_CONFIG_INVALID', 'Pre-order callback URL is invalid', 503)
  }
  return callback.href
}

export async function initializeAuthorPreOrderPayWayQr(intent, review, { signal } = {}) {
  const transaction = preOrderPaymentTransaction(intent?.merchant_transaction_id)
  const cents = preOrderPaymentCents(intent?.expected_amount_usd, 'payment intent amount')
  preOrderPaymentCurrency(intent?.currency)
  const expires = Date.parse(String(intent?.expires_at || ''))
  if (!cents || !Number.isFinite(expires) || expires <= Date.now() + 30_000) {
    throw preOrderError('PRE_ORDER_QR_INTENT_EXPIRED', 'Payment intent is invalid or too close to expiry', 409)
  }
  if (intent.finalized_at || !review?.items?.length || review.items.length !== 1 ||
      preOrderPaymentCents(review.pricing?.total_usd, 'review amount') !== cents) {
    throw preOrderError('PRE_ORDER_QR_REVIEW_MISMATCH', 'Checkout and payment intent disagree', 409)
  }
  const merchantId = String(process.env.ABA_PAYWAY_MERCHANT_ID || '').trim()
  const secret = String(process.env.ABA_PAYWAY_API_KEY || '').trim()
  if (!merchantId || !secret || merchantId.length > 80) {
    throw preOrderError('PRE_ORDER_QR_NOT_CONFIGURED', 'PayWay QR is not configured', 503)
  }
  const remainingMinutes = Math.floor((expires - Date.now()) / 60_000)
  if (remainingMinutes < 1 || remainingMinutes > 15) {
    throw preOrderError('PRE_ORDER_QR_EXPIRY_INVALID', 'Payment intent expiry must be within 15 minutes', 409)
  }
  const item = review.items[0]
  const items = [{ name: String(review.book_title || 'Pre-order').slice(0, 100),
    quantity: Number(item.quantity), price: Number(item.unit_price_usd) }]
  if (Number(review.pricing.signature_fee_usd) > 0) {
    items.push({ name: 'Signed copy', quantity: 1, price: Number(review.pricing.signature_fee_usd) })
  }
  if (Number(review.pricing.delivery_fee_usd) > 0) {
    items.push({ name: 'Delivery', quantity: 1, price: Number(review.pricing.delivery_fee_usd) })
  }
  const reqTime = utcTime()
  const callback = callbackEndpoint()
  const body = {
    req_time: reqTime,
    merchant_id: merchantId,
    tran_id: transaction,
    amount: (cents / 100).toFixed(2),
    items: Buffer.from(JSON.stringify(items), 'utf8').toString('base64'),
    first_name: String(review.buyer_snapshot?.name || 'Shadow').slice(0, 50),
    last_name: 'Preorder',
    email: String(process.env.ABA_PAYWAY_DEFAULT_EMAIL || 'support@shadowerabook.site'),
    phone: String(review.buyer_snapshot?.phone_number || ''),
    purchase_type: 'purchase',
    payment_option: String(process.env.ABA_PAYWAY_PAYMENT_OPTION || 'abapay_khqr'),
    callback_url: Buffer.from(callback, 'utf8').toString('base64'),
    currency: 'USD',
    return_params: JSON.stringify({ order_id: intent.order_id, type: 'author_pre_order' }),
    lifetime: remainingMinutes,
    qr_image_template: String(process.env.ABA_PAYWAY_QR_TEMPLATE || 'template3_color'),
  }
  const hash = createHmac('sha512', secret)
    .update(PAYWAY_FIELDS.map(name => body[name] ?? '').join(''))
    .digest('base64')
  let response
  try {
    response = await fetch(qrEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, hash }),
      cache: 'no-store',
      signal: signal || AbortSignal.timeout(8000),
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw preOrderError('PRE_ORDER_QR_NETWORK_FAILED', 'Could not start PayWay QR payment', 503)
  }
  if (!response.ok) {
    throw preOrderError('PRE_ORDER_QR_PROVIDER_FAILED', 'PayWay QR request was rejected', 503)
  }
  let result
  try { result = await response.json() } catch {
    throw preOrderError('PRE_ORDER_QR_RESPONSE_INVALID', 'PayWay QR response is not JSON', 503)
  }
  const status = String(result?.status?.code ?? '')
  if (status && !['0', '00'].includes(status)) {
    throw preOrderError('PRE_ORDER_QR_PROVIDER_FAILED', 'PayWay could not generate QR', 503)
  }
  const data = result?.data || result || {}
  const qrString = String(data.qrString || data.qr_string || data.khqr || data.qr || '')
  const qrImage = String(data.qrImage || data.qr_image || '')
  const deeplink = String(data.abapay_deeplink || data.deeplink || '')
  const checkoutUrl = String(data.checkout_url || data.payment_url || data.url || '')
  const providerId = String(data.transaction_id || data.tran_id || '')
  if ((!qrString && !qrImage && !deeplink && !checkoutUrl) ||
      (providerId && providerId !== transaction)) {
    throw preOrderError('PRE_ORDER_QR_RESPONSE_INVALID', 'PayWay QR response does not match transaction', 503)
  }
  return {
    transaction_id: transaction,
    amount_usd: cents / 100,
    currency: 'USD',
    expires_at: intent.expires_at,
    qr_string: qrString.slice(0, 8192),
    qr_image: qrImage.slice(0, 250000),
    deeplink: deeplink.slice(0, 4000),
    checkout_url: checkoutUrl.slice(0, 4000),
  }
}
