import crypto from 'node:crypto'

function utcRequestTime(now = new Date()) {
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('')
}

function payWayQrUrl(env) {
  if (env.ABA_PAYWAY_QR_URL) return env.ABA_PAYWAY_QR_URL
  const production = ['production', 'live'].includes(String(env.ABA_PAYWAY_MODE || 'sandbox').toLowerCase())
  return production
    ? env.ABA_PAYWAY_PRODUCTION_QR_URL || 'https://checkout.payway.com.kh/api/payment-gateway/v1/payments/generate-qr'
    : env.ABA_PAYWAY_SANDBOX_QR_URL || 'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr'
}

export async function verifyAuthorStorePdfAbaPayment(order, { env = process.env, fetchImpl = fetch } = {}) {
  const merchantId = String(env.ABA_PAYWAY_MERCHANT_ID || '').trim()
  const apiKey = String(env.ABA_PAYWAY_API_KEY || '').trim()
  const transactionId = String(order?.order_id || '').trim()
  const expectedAmount = Number(order?.total_usd)

  if (!merchantId || !apiKey || !transactionId || !Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    const error = new Error('ABA PDF payment verification configuration is unavailable')
    error.code = 'ABA_PDF_VERIFY_CONFIG'
    throw error
  }

  const generateQrUrl = payWayQrUrl(env)
  const checkUrl = String(env.ABA_PAYWAY_CHECK_TRANSACTION_URL || generateQrUrl.replace(/\/generate-qr(?:\?.*)?$/, '/check-transaction-2'))
  if (!/^https:\/\//i.test(checkUrl) || checkUrl === generateQrUrl) {
    const error = new Error('ABA PDF verification URL is invalid')
    error.code = 'ABA_PDF_VERIFY_URL'
    throw error
  }

  const reqTime = utcRequestTime()
  const hash = crypto.createHmac('sha512', apiKey).update(`${reqTime}${merchantId}${transactionId}`).digest('base64')
  const response = await fetchImpl(checkUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ req_time: reqTime, merchant_id: merchantId, tran_id: transactionId, hash }),
    signal: AbortSignal.timeout(8000),
  })

  if (!response.ok) {
    const error = new Error(`ABA PDF verification request failed with HTTP ${response.status}`)
    error.code = 'ABA_PDF_VERIFY_HTTP'
    throw error
  }

  const result = await response.json()
  const details = result?.data
  if (!['0', '00'].includes(String(result?.status?.code ?? '')) || !details || Array.isArray(details)) {
    return { verified: false, state: 'checking_payment' }
  }

  const confirmedTransactionId = String(result?.status?.tran_id || details.tran_id || details.transaction_id || '').trim()
  if (confirmedTransactionId && confirmedTransactionId !== transactionId) {
    const error = new Error('ABA PDF verification transaction ID mismatch')
    error.code = 'ABA_PDF_VERIFY_MISMATCH'
    throw error
  }

  if (String(details.payment_status || '').toUpperCase() !== 'APPROVED' || Number(details.payment_status_code) !== 0) {
    return { verified: false, state: 'checking_payment' }
  }

  const paidAmount = details.original_amount ?? details.total_amount ?? details.payment_amount
  const currency = String(details.original_currency || details.payment_currency || '').toUpperCase()
  if (paidAmount == null || paidAmount === '' || !Number.isFinite(Number(paidAmount))
      || Number(paidAmount).toFixed(2) !== expectedAmount.toFixed(2)
      || currency !== String(order.currency || 'USD').toUpperCase()) {
    const error = new Error('ABA PDF verification amount or currency mismatch')
    error.code = 'ABA_PDF_VERIFY_MISMATCH'
    throw error
  }

  return { verified: true, state: 'paid', transaction_id: confirmedTransactionId || transactionId }
}
