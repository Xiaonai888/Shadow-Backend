import { prepareAuthorPreOrderReview } from '../services/authorPreOrderOrderPreparation.service.js'

export async function previewReaderPreOrderPreparation(req, res) {
  res.set('Cache-Control', 'private, no-store, max-age=0')
  res.set('Pragma', 'no-cache')
  res.set('Vary', 'Authorization')
  res.set('X-Content-Type-Options', 'nosniff')

  try {
    const review = await prepareAuthorPreOrderReview(
      req.params.campaignId,
      req.user?.user_id,
      req.body
    )
    return res.status(200).json({ ok: true, review })
  } catch (error) {
    const code = String(error?.code || '')
    const statusCode = Number(error?.statusCode)
    const expected = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 &&
      /^PRE_ORDER_[A-Z0-9_]+$/.test(code)

    if (!expected) {
      console.error('PRE_ORDER_PREPARE_FAILED:', String(error?.message || error))
    }

    return res.status(expected ? statusCode : 503).json({
      ok: false,
      code: expected ? code : 'PRE_ORDER_PREPARATION_UNAVAILABLE',
      message: expected ? error.message : 'Could not prepare checkout preview',
    })
  }
}
