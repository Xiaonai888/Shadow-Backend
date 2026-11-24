import { recheckAuthorStorePdfOrder } from '../services/authorStorePdfPaymentRecovery.service.js'
import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'

const VERIFY_STAGES = {
  ABA_PDF_VERIFY_CONFIG: 'verify_configuration',
  ABA_PDF_VERIFY_URL: 'verify_endpoint_configuration',
  ABA_PDF_VERIFY_HTTP: 'verify_provider_http',
  ABA_PDF_VERIFY_TIMEOUT: 'verify_provider_timeout',
  ABA_PDF_VERIFY_NETWORK: 'verify_provider_network',
  ABA_PDF_VERIFY_MISMATCH: 'verify_transaction_mismatch',
}

function recordVerificationFailure(result) {
  const code = String(result.code || 'PDF_PAYMENT_RECHECK_ERROR')
  const stage = Object.hasOwn(VERIFY_STAGES, code) ? VERIFY_STAGES[code] : 'verify_transaction'
  const marker = {
    feature: 'author_store_pdf_payment',
    stage,
    error_code: Object.hasOwn(VERIFY_STAGES, code) ? code : 'PDF_PAYMENT_RECHECK_ERROR',
    verification_source: 'aba_payway',
    response_status: 503,
    handler: 'recheckMyAuthorStorePdfPayment',
  }
  if (code === 'ABA_PDF_VERIFY_CONFIG') {
    const missing = ['ABA_PAYWAY_MERCHANT_ID', 'ABA_PAYWAY_API_KEY']
      .filter((key) => !String(process.env[key] || '').trim())
    marker.error_reason = missing.length ? `missing_env:${missing.join(',')}` : 'invalid_order_verification_input_or_cached_config_failure'
    marker.missing_config_keys = missing.join(',')
  }
  markRequestDiagnostic(marker)
}

export async function recheckMyAuthorStorePdfPayment(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const buyerId = String(req.user?.user_id || req.user?.id || '').trim()
  if (!buyerId) return res.status(401).json({ ok: false, message: 'Sign in required.' })

  try {
    const result = await recheckAuthorStorePdfOrder(buyerId, req.params.orderId)
    const status = result.state === 'verification_unavailable' ? 503
      : result.state === 'access_recovery' ? 202 : 200
    if (status === 503) recordVerificationFailure(result)
    return res.status(status).json(result)
  } catch (error) {
    const status = error.statusCode === 400 || error.statusCode === 404 ? error.statusCode : 503
    if (status === 503) {
      const rawCode = String(error?.code || '').toUpperCase()
      const code = /^[A-Z0-9_]{3,64}$/.test(rawCode) ? rawCode : 'PDF_PAYMENT_RECHECK_ERROR'
      markRequestDiagnostic({
        feature: 'author_store_pdf_payment',
        stage: 'recovery_pipeline',
        error_code: code,
        handler: 'recheckMyAuthorStorePdfPayment',
        response_status: status,
      })
    }
    console.error('AUTHOR PDF PAYMENT RECHECK ERROR:', String(error?.message || error).slice(0, 300))
    return res.status(status).json({
      ok: false,
      code: 'PDF_PAYMENT_RECHECK_ERROR',
      message: 'Unable to recheck this PDF order. Do not pay again while verification is pending.',
    })
  }
}
