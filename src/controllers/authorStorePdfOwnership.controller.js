import { getAuthorStorePdfOwnership } from '../services/authorStorePdfOwnership.service.js'

export async function getMyAuthorStorePdfOwnership(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const userId = String(req.user?.user_id || req.user?.id || '').trim()
  if (!userId) return res.status(401).json({ ok: false, message: 'Sign in required.' })

  try {
    const ids = String(req.query?.product_ids || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    const products = await getAuthorStorePdfOwnership(userId, ids)
    return res.status(200).json({ ok: true, products })
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 404) {
      return res.status(error.statusCode).json({ ok: false, message: error.message })
    }
    console.error('GET PDF OWNERSHIP FAILED:', String(error?.message || error))
    return res.status(503).json({
      ok: false,
      code: 'PDF_OWNERSHIP_CHECK_UNAVAILABLE',
      message: 'Unable to check PDF ownership right now.',
    })
  }
}
