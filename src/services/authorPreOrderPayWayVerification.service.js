import { createHmac } from 'node:crypto'
import { preOrderError } from './authorPreOrderValidation.service.js'
import {
  preOrderPaymentCents,
  preOrderPaymentCurrency,
  preOrderPaymentTransaction,
  preOrderProviderPaidAt,
} from './authorPreOrderPaymentValidation.service.js'

const OFFICIAL_HOSTS = new Set(['checkout.payway.com.kh', 'checkout-sandbox.payway.com.kh'])

function payWayCheckUrl() {
  const configured = String(process.env.ABA_PAYWAY_CHECK_TRANSACTION_URL || '').trim()
  const mode = String(process.env.ABA_PAYWAY_MODE || 'sandbox').trim().toLowerCase()
  const defaultHost = mode === 'production' || mode === 'live'
    ? 'checkout.payway.com.kh'
    : 'checkout-sandbox.payway.com.kh'
  const address = configured || `https://${defaultHost}/api/payment-gateway/v1/payments/check-transaction-2`
  let url
  try {
    url = new URL(address)
  } catch {
    throw preOrderError('PRE_ORDER_PAYWAY_CONFIG_INVALID', 'Payment verification is not configured', 503)
  }
  if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.has(url.hostname) || url.username ||
      url.password || url.port || url.search || url.hash ||
      !url.pathname.endsWith('/check-transaction-2')) {
    throw preOrderError('PRE_ORDER_PAYWAY_CONFIG_INVALID', 'Payment verification endpoint is invalid', 503)
  }
  return url.href
}

function utcRequestTime() {
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  const hh = String(now.getUTCHours()).padStart(2, '0')
  const mi = String(now.getUTCMinutes()).padStart(2, '0')
  const ss = String(now.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`
}

export async function verifyAuthorPreOrderPayWaySettlement(intent, { signal } = {}) {
  const transactionId = preOrderPaymentTransaction(intent?.merchant_transaction_id)
  const amountCents = preOrderPaymentCents(intent?.expected_amount_usd, 'expected payment amount')
  const currency = preOrderPaymentCurrency(intent?.currency)
  if (amountCents < 1) {
    throw preOrderError('PRE_ORDER_PAYMENT_AMOUNT_INVALID', 'Payment amount must be greater than zero', 503)
  }
  const merchantId = String(process.env.ABA_PAYWAY_MERCHANT_ID || '').trim()
  const apiKey = String(process.env.ABA_PAYWAY_API_KEY || '').trim()
  if (!merchantId || !apiKey || merchantId.length > 80) {
    throw preOrderError('PRE_ORDER_PAYWAY_NOT_CONFIGURED', 'PayWay verification is unavailable', 503)
  }
  const url = payWayCheckUrl()
  const reqTime = utcRequestTime()
  const hash = createHmac('sha512', apiKey)
    .update(`${reqTime}${merchantId}${transactionId}`)
    .digest('base64')
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ req_time: reqTime, merchant_id: merchantId, tran_id: transactionId, hash }),
      signal: signal || AbortSignal.timeout(8000),
      cache: 'no-store',
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw preOrderError('PRE_ORDER_PAYWAY_UNREACHABLE', 'Could not verify payment with PayWay', 503)
  }
  if (!response.ok) {
    throw preOrderError('PRE_ORDER_PAYWAY_UNAVAILABLE', 'PayWay verification request failed', 503)
  }
  let result
  try {
    result = await response.json()
  } catch {
    throw preOrderError('PRE_ORDER_PAYWAY_RESPONSE_INVALID', 'PayWay returned an invalid response', 503)
  }
  const details = result?.data
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      !details || typeof details !== 'object' || Array.isArray(details)) {
    throw preOrderError('PRE_ORDER_PAYWAY_RESPONSE_INVALID', 'PayWay verification response is incomplete', 503)
  }
  const status = String(result?.status?.code ?? '').trim()
  const paymentStatus = String(details.payment_status ?? '').trim().toUpperCase()
  const paymentCode = String(details.payment_status_code ?? '').trim()
  if (!['0', '00'].includes(status) || paymentStatus !== 'APPROVED' || !['0', '00'].includes(paymentCode)) {
    return { confirmed: false, code: 'PRE_ORDER_PAYWAY_NOT_APPROVED' }
  }
  const confirmedId = String(result?.status?.tran_id || details.tran_id || details.transaction_id || '').trim()
  if (!confirmedId || confirmedId !== transactionId) {
    throw preOrderError('PRE_ORDER_PAYWAY_TRANSACTION_MISMATCH', 'Provider transaction does not match the order', 409)
  }
  const paidAmount = details.original_amount ?? details.total_amount ?? details.payment_amount
  const paidCurrency = String(details.original_currency || details.payment_currency || '').trim().toUpperCase()
  if (paidAmount === null || paidAmount === undefined || paidAmount === '' || paidCurrency !== currency ||
      preOrderPaymentCents(paidAmount, 'provider amount') !== amountCents) {
    throw preOrderError('PRE_ORDER_PAYWAY_AMOUNT_MISMATCH', 'Provider payment amount or currency does not match', 409)
  }
  const providerMerchant = String(details.merchant_id ?? '').trim()
  if (providerMerchant && providerMerchant !== merchantId) {
    throw preOrderError('PRE_ORDER_PAYWAY_MERCHANT_MISMATCH', 'Payment merchant does not match', 409)
  }
  return {
    confirmed: true,
    merchant_transaction_id: transactionId,
    amount_usd: amountCents / 100,
    currency,
    provider_paid_at: preOrderProviderPaidAt(details.paid_at || details.transaction_date || null),
  }
}
