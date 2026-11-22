import {
  authorStorePdfCheckoutDecision,
  getAuthorStorePdfOwnership,
} from '../services/authorStorePdfOwnership.service.js'

export async function requireUnpurchasedAuthorStorePdf(req, res, next) {
  res.set('Cache-Control', 'private, no-store')
  const userId = String(req.user?.user_id || req.user?.id || '').trim()
  if (!userId) return res.status(401).json({ ok: false, message: 'Sign in required.' })

  try {
    const items = req.body?.items
    if (!Array.isArray(items) || !items.length || items.length > 30) {
      return res.status(400).json({ ok: false, message: 'Invalid checkout items.' })
    }
    const ids = items.map((item) => String(item?.id || item?.product_id || item?.productId || '').trim())
    if (ids.some((id) => !id)) {
      return res.status(400).json({ ok: false, message: 'Invalid checkout product.' })
    }
    const ownership = await getAuthorStorePdfOwnership(userId, ids)
    const decision = authorStorePdfCheckoutDecision(ownership)
    if (decision) return res.status(409).json(decision)
    return next()
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 404) {
      return res.status(error.statusCode).json({ ok: false, message: error.message })
    }
    console.error('AUTHOR STORE PDF PURCHASE GUARD FAILED:', String(error?.message || error))
    return res.status(503).json({
      ok: false,
      code: 'PDF_OWNERSHIP_CHECK_UNAVAILABLE',
      message: 'Unable to check PDF ownership. No new payment was started; please retry later.',
    })
  }
}
