import { startReaderAuthorPreOrderCheckout } from '../services/authorPreOrderCheckoutStart.service.js'

export async function startReaderPreOrderCheckout(req, res) {
  res.set('Cache-Control', 'private, no-store, max-age=0')
  res.set('Pragma', 'no-cache')
  res.set('Vary', 'Authorization')
  res.set('X-Content-Type-Options', 'nosniff')

  try {
    const result = await startReaderAuthorPreOrderCheckout(
      req.params.campaignId,
      req.user?.user_id,
      req.body
    )
    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    const status = Number(error?.statusCode)
    const code = String(error?.code || '')
    const expected = Number.isInteger(status) && status >= 400 && status < 600 &&
      /^PRE_ORDER_[A-Z0-9_]+$/.test(code)
    if (!expected) {
      console.error('PRE_ORDER_CHECKOUT_START_FAILED:', String(error?.code || error?.name || 'unknown'))
    }
    return res.status(expected ? status : 503).json({
      ok: false,
      code: expected ? code : 'PRE_ORDER_CHECKOUT_UNAVAILABLE',
      message: expected ? error.message : 'Checkout is temporarily unavailable',
    })
  }
}
