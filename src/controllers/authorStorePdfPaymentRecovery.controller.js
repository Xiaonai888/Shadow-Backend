import { recheckAuthorStorePdfOrder } from '../services/authorStorePdfPaymentRecovery.service.js'

export async function recheckMyAuthorStorePdfPayment(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const buyerId = String(req.user?.user_id || req.user?.id || '').trim()
  if (!buyerId) return res.status(401).json({ ok: false, message: 'Sign in required.' })

  try {
    const result = await recheckAuthorStorePdfOrder(buyerId, req.params.orderId)
    const status = result.state === 'verification_unavailable' ? 503
      : result.state === 'access_recovery' ? 202 : 200
    return res.status(status).json(result)
  } catch (error) {
    console.error('AUTHOR PDF PAYMENT RECHECK ERROR:', String(error?.message || error).slice(0, 300))
    return res.status(error.statusCode === 400 || error.statusCode === 404 ? error.statusCode : 503).json({
      ok: false,
      code: 'PDF_PAYMENT_RECHECK_ERROR',
      message: 'Unable to recheck this PDF order. Do not pay again while verification is pending.',
    })
  }
}
